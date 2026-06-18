<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { onMount } from 'svelte';
	import { t } from '$lib/translations';
	import type {
		IActivityEvent,
		IJob,
		IQueueOverview,
		IServiceHealth,
		ISystemHealth,
		JobStatus,
		IMonitorResponse,
		ServiceHealthId,
	} from '@open-archiver/types';

	type ActivityLevel = 'info' | 'warn' | 'error' | 'success';

	type ActivityLine = {
		id: string;
		at: Date;
		level: ActivityLevel;
		source: string;
		message: string;
	};

	let { onQueuesUpdate }: { onQueuesUpdate?: (queues: IQueueOverview[]) => void } = $props();

	const POLL_INTERVAL_MS = 5000;
	const WATCH_STATUSES: JobStatus[] = ['active', 'delayed', 'waiting', 'failed'];
	const MAX_LINES = 300;

	let lines = $state<ActivityLine[]>([]);
	let health = $state<ISystemHealth | null>(null);
	let resources = $state<IMonitorResponse['resources'] | null>(null);
	let isPaused = $state(false);
	let isPolling = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let streamEl: HTMLDivElement | undefined = $state();
	let lineId = 0;
	let lastEventAt: string | undefined;
	const seenEventIds = new Set<string>();
	let lastQueueSignature = '';
	let authFailed = $state(false);

	function pushLine(
		level: ActivityLevel,
		source: string,
		message: string,
		at: Date = new Date(),
		id?: string
	) {
		lines = [
			...lines.slice(-(MAX_LINES - 1)),
			{ id: id ?? String(++lineId), at, level, source, message },
		];
		queueMicrotask(() => {
			if (streamEl) {
				streamEl.scrollTop = streamEl.scrollHeight;
			}
		});
	}

	function formatTime(date: Date): string {
		return date.toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	}

	const SERVICE_LABEL_KEYS: Record<ServiceHealthId, string> = {
		database: 'app.jobs.health_database',
		redis: 'app.jobs.health_redis',
		meilisearch: 'app.jobs.health_meilisearch',
		ingestion_worker: 'app.jobs.health_ingestion_worker',
		indexing_worker: 'app.jobs.health_indexing_worker',
	};

	function serviceLabel(id: ServiceHealthId): string {
		return $t(SERVICE_LABEL_KEYS[id]);
	}

	function statusLabel(status: IServiceHealth['status']): string {
		return $t(`app.jobs.health_status_${status}`);
	}

	function healthBadgeClass(status: IServiceHealth['status']): string {
		if (status === 'healthy') return 'bg-emerald-500';
		if (status === 'degraded') return 'bg-amber-500';
		return 'bg-red-500';
	}

	function formatQueueSignature(queues: IQueueOverview[]): string {
		return queues
			.map((queue) => {
				const c = queue.counts;
				return `${queue.name}:${c.active},${c.waiting},${c.delayed},${c.failed},${c.completed}`;
			})
			.join('|');
	}

	function formatQueueSummary(queue: IQueueOverview): string {
		const c = queue.counts;
		return `${queue.name}: ${$t('app.jobs.active')}=${c.active}, ${$t('app.jobs.waiting')}=${c.waiting}, ${$t('app.jobs.delayed')}=${c.delayed}, ${$t('app.jobs.failed')}=${c.failed}, ${$t('app.jobs.completed')}=${c.completed}`;
	}

	function formatJobLine(queueName: string, status: JobStatus, job: IJob): string {
		const parts = [`${queueName}/${status}`, job.name, `#${job.id}`];
		if (job.ingestionSourceId) {
			parts.push(`source=${job.ingestionSourceId}`);
		}
		if (job.attemptsMade > 0) {
			parts.push(`attempts=${job.attemptsMade}`);
		}
		if (job.failedReason) {
			parts.push(`error=${job.failedReason}`);
		}
		return parts.join(' · ');
	}

	async function fetchJobsForStatus(queueName: string, status: JobStatus): Promise<IJob[]> {
		const params = new URLSearchParams({
			queue: queueName,
			status,
			limit: '5',
		});
		const res = await fetch(`/dashboard/admin/jobs/queue-jobs?${params.toString()}`, {
			credentials: 'same-origin',
		});
		if (!res.ok) {
			return [];
		}
		const details = await res.json();
		return details.jobs ?? [];
	}

	function ingestServerEvents(events: IActivityEvent[]) {
		for (const event of events) {
			if (seenEventIds.has(event.id)) {
				continue;
			}
			seenEventIds.add(event.id);
			pushLine(event.level, event.source, event.message, new Date(event.at), event.id);
			if (!lastEventAt || event.at > lastEventAt) {
				lastEventAt = event.at;
			}
		}
	}

	async function logQueueDeltas(queues: IQueueOverview[]) {
		const signature = formatQueueSignature(queues);
		if (signature === lastQueueSignature) {
			return;
		}
		lastQueueSignature = signature;
		pushLine('info', 'queue', `${$t('app.jobs.stream_snapshot')} — ${new Date().toLocaleString()}`);

		for (const queue of queues) {
			pushLine('info', 'queue', formatQueueSummary(queue));

			for (const status of WATCH_STATUSES) {
				if (queue.counts[status] <= 0) {
					continue;
				}
				const jobs = await fetchJobsForStatus(queue.name, status);
				for (const job of jobs) {
					const level: ActivityLevel =
						status === 'failed' ? 'error' : status === 'active' ? 'success' : 'warn';
					pushLine(level, 'queue', formatJobLine(queue.name, status, job));
				}
			}
		}
	}

	async function refreshMonitor() {
		if (isPaused || authFailed) {
			return;
		}

		isPolling = true;
		try {
			const query = lastEventAt ? `?since=${encodeURIComponent(lastEventAt)}` : '';
			const res = await fetch(`/dashboard/admin/jobs/monitor${query}`, {
				credentials: 'same-origin',
			});
			if (res.status === 401) {
				authFailed = true;
				stopPolling();
				pushLine('error', 'monitor', $t('app.jobs.stream_unauthorized'));
				return;
			}
			if (!res.ok) {
				pushLine('error', 'monitor', `${$t('app.jobs.stream_fetch_failed')} (${res.status})`);
				return;
			}

			const payload: IMonitorResponse = await res.json();
			health = payload.health;
			resources = payload.resources ?? null;
			onQueuesUpdate?.(payload.queues);
			ingestServerEvents(payload.events);
			await logQueueDeltas(payload.queues);
		} finally {
			isPolling = false;
		}
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function clearStream() {
		lines = [];
		seenEventIds.clear();
		lastEventAt = undefined;
		lastQueueSignature = '';
	}

	function togglePause() {
		isPaused = !isPaused;
		if (!isPaused && !authFailed) {
			void refreshMonitor();
		}
	}

	onMount(() => {
		pushLine('info', 'monitor', $t('app.jobs.stream_started'));
		void refreshMonitor();
		pollTimer = setInterval(() => {
			void refreshMonitor();
		}, POLL_INTERVAL_MS);

		return () => {
			stopPolling();
		};
	});

	const levelClass: Record<ActivityLevel, string> = {
		info: 'text-muted-foreground',
		warn: 'text-amber-400',
		error: 'text-red-400',
		success: 'text-emerald-400',
	};
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header class="flex flex-row items-center justify-between gap-4 space-y-0">
			<div>
				<Card.Title>{$t('app.jobs.health_title')}</Card.Title>
				<Card.Description>
					{#if health}
						{$t('app.jobs.health_checked_at')}
						{new Date(health.checkedAt).toLocaleString()}
					{:else}
						{$t('app.jobs.health_loading')}
					{/if}
				</Card.Description>
			</div>
		</Card.Header>
		<Card.Content>
			{#if health}
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
					{#each health.services as service (service.id)}
						<div class="border-border rounded-md border p-3">
							<div class="mb-2 flex items-center justify-between gap-2">
								<span class="text-sm font-medium">{serviceLabel(service.id)}</span>
								<Badge class={healthBadgeClass(service.status)}>
									{statusLabel(service.status)}
								</Badge>
							</div>
							<div class="text-muted-foreground space-y-1 text-xs">
								{#if service.latencyMs !== undefined}
									<p>{$t('app.jobs.health_latency')}: {service.latencyMs}ms</p>
								{/if}
								{#if service.message}
									<p class="break-all">{service.message}</p>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-muted-foreground text-sm">{$t('app.jobs.health_loading')}</p>
			{/if}
		</Card.Content>
	</Card.Root>

	{#if resources}
		<Card.Root>
			<Card.Header>
				<Card.Title>{$t('app.jobs.resources_title')}</Card.Title>
				<Card.Description>
					{$t('app.jobs.resources_description', {
						profile: resources.tuning.profile,
						source: resources.tuning.profileSource,
					})}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="grid gap-4 md:grid-cols-2">
					<div class="space-y-2 text-sm">
						<p class="font-medium">{$t('app.jobs.resources_hardware')}</p>
						<ul class="text-muted-foreground space-y-1 text-xs">
							<li>
								{$t('app.jobs.resources_ram')}: {resources.capacity.effectiveMemGb} GB
								{#if resources.capacity.cgroupMemLimited}
									({$t('app.jobs.resources_cgroup')}, {$t('app.jobs.resources_host')}
									{resources.capacity.hostMemGb} GB)
								{/if}
							</li>
							<li>
								{$t('app.jobs.resources_cpu')}: {resources.capacity.effectiveCpus}
								{#if resources.capacity.cgroupCpuLimited}
									({$t('app.jobs.resources_cgroup')}, {$t('app.jobs.resources_host')}
									{resources.capacity.hostCpus})
								{/if}
							</li>
							<li>
								{$t('app.jobs.resources_platform')}: {$t(
									`app.jobs.resources_virt_${resources.capacity.virtualization}`
								)}
								{#if resources.capacity.virtualizationDetail}
									<span class="text-muted-foreground">
										({resources.capacity.virtualizationDetail})
									</span>
								{/if}
							</li>
						</ul>
					</div>
					<div class="space-y-2 text-sm">
						<p class="font-medium">{$t('app.jobs.resources_tuning')}</p>
						<ul class="text-muted-foreground space-y-1 text-xs">
							<li>
								{$t('app.jobs.resources_ingestion_workers')}:
								{resources.tuning.ingestionWorkerConcurrency}
							</li>
							<li>
								{$t('app.jobs.resources_indexing_workers')}:
								{resources.tuning.indexingWorkerConcurrency}
							</li>
							<li>
								{$t('app.jobs.resources_indexing_batch')}:
								{resources.tuning.indexingBatchSize}
							</li>
							<li>
								{$t('app.jobs.resources_node_heap')}: {resources.tuning.nodeMaxOldSpaceMb} MB
							</li>
							<li>
								{$t('app.jobs.resources_sync')}: {resources.tuning.syncFrequency}
							</li>
						</ul>
					</div>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root>
		<Card.Header class="flex flex-row items-center justify-between gap-4 space-y-0">
			<div>
				<Card.Title>{$t('app.jobs.activity_stream')}</Card.Title>
				<Card.Description>{$t('app.jobs.activity_stream_description')}</Card.Description>
			</div>
			<div class="flex items-center gap-2">
				{#if isPolling}
					<span class="text-muted-foreground text-xs">{$t('app.jobs.stream_polling')}</span>
				{/if}
				<Button variant="outline" size="sm" onclick={togglePause}>
					{isPaused ? $t('app.jobs.stream_resume') : $t('app.jobs.stream_pause')}
				</Button>
				<Button variant="outline" size="sm" onclick={clearStream}>
					{$t('app.jobs.stream_clear')}
				</Button>
			</div>
		</Card.Header>
		<Card.Content>
			<div
				bind:this={streamEl}
				class="bg-background border-border max-h-[28rem] min-h-[16rem] overflow-y-auto rounded-md border p-3 font-mono text-xs leading-5"
				role="log"
				aria-live="polite"
				aria-relevant="additions"
			>
				{#if lines.length === 0}
					<p class="text-muted-foreground">{$t('app.jobs.stream_empty')}</p>
				{:else}
					{#each lines as line (line.id)}
						<div class="whitespace-pre-wrap break-all py-0.5">
							<span class="text-muted-foreground">{formatTime(line.at)}</span>
							<span class="text-primary/80 mx-2">[{line.source}]</span>
							<span class="{levelClass[line.level]}">{line.message}</span>
						</div>
					{/each}
				{/if}
			</div>
		</Card.Content>
	</Card.Root>
</div>
