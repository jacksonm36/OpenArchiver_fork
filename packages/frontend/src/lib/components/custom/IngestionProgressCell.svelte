<script lang="ts">
	import type { IngestionDiagnostics } from '@open-archiver/types';
	import Badge from '$lib/components/ui/badge/badge.svelte';
	import { Progress } from '$lib/components/ui/progress';
	import { t } from '$lib/translations';

	let {
		status,
		diagnostics,
		getStatusClasses,
	}: {
		status: string;
		diagnostics: IngestionDiagnostics | null;
		getStatusClasses: (status: string) => string;
	} = $props();

	const showProgress = $derived(
		diagnostics &&
			(status === 'importing' ||
				status === 'syncing' ||
				diagnostics.progress.phase === 'indexing' ||
				diagnostics.progress.isIndeterminate)
	);

	const progressValue = $derived(() => {
		if (!diagnostics || diagnostics.progress.isIndeterminate) return undefined;
		if (diagnostics.progress.phase === 'indexing' && diagnostics.progress.indexingPercent !== null) {
			return diagnostics.progress.indexingPercent;
		}
		if (diagnostics.progress.mailboxPercent !== null) {
			return diagnostics.progress.mailboxPercent;
		}
		return undefined;
	});
</script>

<div class="min-w-[8rem] space-y-1.5">
	<Badge class="{getStatusClasses(status)} capitalize">
		{status.split('_').join(' ')}
	</Badge>

	{#if showProgress && diagnostics}
		{#if diagnostics.progress.isIndeterminate}
			<div class="bg-primary/20 relative h-1.5 w-full overflow-hidden rounded-full">
				<div class="bg-primary absolute inset-y-0 left-0 w-1/3 animate-pulse"></div>
			</div>
		{:else if progressValue() !== undefined}
			<Progress value={progressValue()} class="h-1.5" />
		{/if}
		<p class="text-muted-foreground truncate text-[10px]" title={diagnostics.progress.label}>
			{diagnostics.progress.label}
		</p>
	{:else if diagnostics?.archivedEmailCount}
		<p class="text-muted-foreground text-[10px]">
			{diagnostics.archivedEmailCount.toLocaleString()}
			{$t('app.ingestions.emails_short')}
		</p>
	{/if}
</div>
