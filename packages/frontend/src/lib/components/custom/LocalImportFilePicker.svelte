<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api.client';
	import { Button } from '$lib/components/ui/button';
	import { formatUploadBytes } from '$lib/upload.client';
	import { t } from '$lib/translations';
	import type {
		IImportDirectoryListing,
		IImportSettings,
		IngestionProvider,
	} from '@open-archiver/types';
	import { Loader2, Folder, File } from 'lucide-svelte';

	let {
		provider,
		settings,
		value = $bindable<string | undefined>(),
	}: {
		provider: IngestionProvider;
		settings: IImportSettings | null;
		value?: string;
	} = $props();

	const selectedPath = $derived(value ?? '');

	let listing = $state<IImportDirectoryListing | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	async function loadDirectory(directory?: string) {
		loading = true;
		error = null;
		try {
			const params = new URLSearchParams({ provider });
			if (directory) {
				params.set('directory', directory);
			}
			const res = await api(`/ingestion-sources/import-files?${params.toString()}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message || `Failed to list files (${res.status})`);
			}
			listing = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			listing = null;
		} finally {
			loading = false;
		}
	}

	function selectPath(path: string) {
		value = path;
	}

	function openDirectory(path: string) {
		void loadDirectory(path);
	}

	function goUp() {
		if (!listing) return;
		const parent = listing.directory.replace(/[\\/][^\\/]+$/, '');
		const allowed = listing.allowedRoots.some(
			(root) => parent === root || parent.startsWith(`${root}/`) || parent.startsWith(`${root}\\`)
		);
		if (allowed && parent.length >= listing.allowedRoots[0]?.length) {
			void loadDirectory(parent);
			return;
		}
		void loadDirectory(listing.allowedRoots[0]);
	}

	onMount(() => {
		void loadDirectory(settings?.suggestedImportDir);
	});
</script>

<div class="space-y-3">
	{#if settings}
		<p class="text-muted-foreground text-xs">
			{$t('app.components.ingestion_source_form.local_path_help')}
		</p>
		<ul class="text-muted-foreground list-inside list-disc text-xs">
			{#each settings.allowedRoots as root}
				<li><code class="text-foreground">{root}</code></li>
			{/each}
		</ul>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<Button type="button" variant="outline" size="sm" onclick={() => loadDirectory(listing?.directory)}>
			{$t('app.components.ingestion_source_form.refresh_server_files')}
		</Button>
		{#if listing}
			<Button type="button" variant="ghost" size="sm" onclick={goUp}>
				{$t('app.components.ingestion_source_form.parent_directory')}
			</Button>
		{/if}
		{#if loading}
			<Loader2 class="h-4 w-4 animate-spin" />
		{/if}
	</div>

	{#if error}
		<p class="text-destructive text-xs">{error}</p>
	{/if}

	{#if listing}
		<p class="text-muted-foreground text-xs">
			<code class="text-foreground">{listing.directory}</code>
		</p>
		<div class="border-border max-h-48 overflow-y-auto rounded-md border">
			{#if listing.entries.length === 0}
				<p class="text-muted-foreground p-3 text-xs">
					{$t('app.components.ingestion_source_form.no_server_files')}
				</p>
			{:else}
				<ul class="divide-y">
					{#each listing.entries as entry (entry.path)}
						<li>
							{#if entry.isDirectory}
								<button
									type="button"
									class="hover:bg-muted flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
									onclick={() => openDirectory(entry.path)}
								>
									<Folder class="h-4 w-4 shrink-0" />
									<span>{entry.name}/</span>
								</button>
							{:else}
								<button
									type="button"
									class="hover:bg-muted flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm {selectedPath ===
									entry.path
										? 'bg-muted'
										: ''}"
									onclick={() => selectPath(entry.path)}
								>
									<span class="flex min-w-0 items-center gap-2">
										<File class="h-4 w-4 shrink-0" />
										<span class="truncate">{entry.name}</span>
									</span>
									{#if entry.sizeBytes !== undefined}
										<span class="text-muted-foreground shrink-0 text-xs">
											{formatUploadBytes(entry.sizeBytes)}
										</span>
									{/if}
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
