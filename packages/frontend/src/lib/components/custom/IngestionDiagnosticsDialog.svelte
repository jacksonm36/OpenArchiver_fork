<script lang="ts">
	import type { IngestionDiagnostics, SafeIngestionSource, ResumeImportMode } from '@open-archiver/types';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { api } from '$lib/api.client';
	import { Loader2, Play } from 'lucide-svelte';
	import { t } from '$lib/translations';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';

	let {
		source,
		open = $bindable(false),
		onResume,
	}: {
		source: SafeIngestionSource | null;
		open?: boolean;
		onResume?: () => void;
	} = $props();

	let loading = $state(false);
	let resuming = $state(false);
	let diagnostics = $state<IngestionDiagnostics | null>(null);
	let error = $state<string | null>(null);

	async function loadDiagnostics() {
		if (!source) return;
		loading = true;
		error = null;
		try {
			const res = await api(`/ingestion-sources/${source.id}/diagnostics`);
			const body = await res.json();
			if (!res.ok) {
				throw new Error(body.message || 'Failed to load diagnostics');
			}
			diagnostics = body as IngestionDiagnostics;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			diagnostics = null;
		} finally {
			loading = false;
		}
	}

	async function resumeImport(mode: ResumeImportMode) {
		if (!source) return;
		resuming = true;
		try {
			const res = await api(`/ingestion-sources/${source.id}/resume-import`, {
				method: 'POST',
				body: JSON.stringify({ mode }),
			});
			const body = await res.json();
			if (!res.ok) {
				throw new Error(body.message || 'Failed to resume');
			}
			setAlert({
				type: 'success',
				title: $t('app.ingestions.resume_import_success'),
				message: '',
				duration: 3000,
				show: true,
			});
			onResume?.();
			open = false;
		} catch (e) {
			setAlert({
				type: 'error',
				title: $t('app.ingestions.resume_import_failed'),
				message: e instanceof Error ? e.message : String(e),
				duration: 5000,
				show: true,
			});
		} finally {
			resuming = false;
		}
	}

	$effect(() => {
		if (open && source) {
			loadDiagnostics();
		}
	});

	const progressValue = $derived(() => {
		if (!diagnostics) return 0;
		if (diagnostics.progress.isIndeterminate) return undefined;
		if (diagnostics.progress.phase === 'indexing' && diagnostics.progress.indexingPercent !== null) {
			return diagnostics.progress.indexingPercent;
		}
		if (diagnostics.progress.mailboxPercent !== null) {
			return diagnostics.progress.mailboxPercent;
		}
		return diagnostics.progress.phase === 'complete' ? 100 : 0;
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{$t('app.ingestions.diagnostics_title')}</Dialog.Title>
			<Dialog.Description>
				{source?.name ?? ''} — {$t('app.ingestions.diagnostics_description')}
			</Dialog.Description>
		</Dialog.Header>

		{#if loading}
			<div class="flex items-center justify-center py-8">
				<Loader2 class="text-primary h-6 w-6 animate-spin" />
			</div>
		{:else if error}
			<p class="text-destructive text-sm">{error}</p>
		{:else if diagnostics}
			<div class="space-y-5 text-sm">
				<div>
					<p class="text-muted-foreground mb-2">{diagnostics.progress.label}</p>
					{#if diagnostics.progress.isIndeterminate}
						<div class="bg-primary/20 relative h-2 w-full overflow-hidden rounded-full">
							<div class="bg-primary absolute inset-y-0 left-0 w-1/3 animate-pulse"></div>
						</div>
					{:else}
						<Progress value={progressValue()} class="h-2" />
					{/if}
					{#if diagnostics.progress.indexingPercent !== null && diagnostics.archivedEmailCount > 0}
						<p class="text-muted-foreground mt-1 text-xs">
							{$t('app.ingestions.indexing_progress', {
								indexed: diagnostics.indexedEmailCount,
								total: diagnostics.archivedEmailCount,
							})}
						</p>
					{/if}
				</div>

				{#if diagnostics.resume?.available}
					<div class="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
						<p class="mb-2 font-medium">{$t('app.ingestions.resume_import')}</p>
						{#if diagnostics.resume.lastGlobalIndex !== null}
							<p class="text-muted-foreground mb-3 text-xs">
								{$t('app.ingestions.resume_checkpoint', {
									index: diagnostics.resume.lastGlobalIndex + 1,
								})}
								{#if diagnostics.resume.lastMessageId}
									<br />
									<span class="font-mono">{diagnostics.resume.lastMessageId}</span>
								{/if}
							</p>
						{/if}
						<div class="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={resuming}
								onclick={() => resumeImport('dedup')}
							>
								<Play class="mr-2 h-3.5 w-3.5" />
								{$t('app.ingestions.resume_dedup')}
							</Button>
							<Button size="sm" disabled={resuming} onclick={() => resumeImport('import')}>
								<Play class="mr-2 h-3.5 w-3.5" />
								{$t('app.ingestions.resume_import')}
							</Button>
						</div>
						<p class="text-muted-foreground mt-2 text-xs">
							{$t('app.ingestions.resume_dedup_description')}
						</p>
					</div>
				{/if}

				<div class="grid grid-cols-2 gap-3">
					<div class="rounded-md border p-3">
						<p class="text-muted-foreground text-xs">{$t('app.ingestions.emails_archived')}</p>
						<p class="text-lg font-semibold">
							{diagnostics.archivedEmailCount.toLocaleString()}
						</p>
					</div>
					<div class="rounded-md border p-3">
						<p class="text-muted-foreground text-xs">{$t('app.ingestions.pending_index')}</p>
						<p class="text-lg font-semibold">
							{diagnostics.pendingIndexCount.toLocaleString()}
						</p>
					</div>
				</div>

				<div class="rounded-md border p-3">
					<p class="mb-2 font-medium">{$t('app.ingestions.queue_status')}</p>
					<ul class="text-muted-foreground space-y-1 text-xs">
						<li>
							{$t('app.ingestions.ingestion_jobs')}: {diagnostics.queue.ingestionActive}
							{$t('app.ingestions.active')}, {diagnostics.queue.ingestionWaiting}
							{$t('app.ingestions.waiting')}
						</li>
						<li>
							{$t('app.ingestions.indexing_jobs')}: {diagnostics.queue.indexingActive}
							{$t('app.ingestions.active')}, {diagnostics.queue.indexingWaiting}
							{$t('app.ingestions.waiting')}
						</li>
					</ul>
				</div>

				{#if diagnostics.lastSyncStatusMessage}
					<div class="rounded-md border p-3">
						<p class="mb-1 font-medium">{$t('app.ingestions.last_sync_message')}</p>
						<p class="text-muted-foreground font-mono text-xs whitespace-pre-wrap">
							{diagnostics.lastSyncStatusMessage}
						</p>
					</div>
				{/if}

				{#if diagnostics.activeSyncSession?.errorMessages?.length}
					<div class="border-destructive/40 rounded-md border p-3">
						<p class="text-destructive mb-2 font-medium">
							{$t('app.ingestions.session_errors')}
						</p>
						<ul class="space-y-2">
							{#each diagnostics.activeSyncSession.errorMessages as message}
								<li class="bg-destructive/10 rounded p-2 font-mono text-xs">{message}</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if diagnostics.queue.recentFailures.length > 0}
					<div class="border-destructive/40 rounded-md border p-3">
						<p class="text-destructive mb-2 font-medium">
							{$t('app.ingestions.job_failures')}
						</p>
						<div class="max-h-48 space-y-3 overflow-y-auto">
							{#each diagnostics.queue.recentFailures as failure}
								<div class="bg-muted rounded p-2">
									<p class="font-mono text-xs font-semibold">
										[{failure.queue}] {failure.name} (#{failure.id})
									</p>
									{#if failure.failedReason}
										<p class="text-destructive mt-1 text-xs">{failure.failedReason}</p>
									{/if}
									{#if failure.stacktrace?.length}
										<pre class="text-muted-foreground mt-1 max-h-24 overflow-auto text-[10px] whitespace-pre-wrap">{failure.stacktrace.join('\n')}</pre>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={loadDiagnostics} disabled={loading || !source}>
				{$t('app.ingestions.refresh_diagnostics')}
			</Button>
			<Button onclick={() => (open = false)}>{$t('app.ingestions.close')}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
