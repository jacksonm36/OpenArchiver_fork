<script lang="ts">
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import Folder from 'lucide-svelte/icons/folder';

	let { path }: { path: string } = $props();

	const segments = $derived(path.split('/').filter((segment) => segment.length > 0));
</script>

{#if segments.length > 0}
	<div class="text-muted-foreground flex flex-wrap items-center gap-1 text-sm">
		<Folder class="h-4 w-4 shrink-0" />
		{#each segments as segment, index (index)}
			{#if index > 0}
				<ChevronRight class="h-3.5 w-3.5 shrink-0 opacity-60" />
			{/if}
			<span class="bg-muted rounded px-1.5 py-0.5 text-xs">{segment}</span>
		{/each}
	</div>
{/if}
