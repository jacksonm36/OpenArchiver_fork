<script lang="ts">
	import type { ArchiveFolderNode } from '@open-archiver/types';
	import * as ScrollArea from '$lib/components/ui/scroll-area';
	import { cn } from '$lib/utils';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import ChevronDown from 'lucide-svelte/icons/chevron-down';
	import Folder from 'lucide-svelte/icons/folder';
	import FolderOpen from 'lucide-svelte/icons/folder-open';
	import Inbox from 'lucide-svelte/icons/inbox';
	import { t } from '$lib/translations';

	let {
		nodes,
		selectedPath = null,
		totalCount = 0,
		onSelect,
	}: {
		nodes: ArchiveFolderNode[];
		selectedPath?: string | null;
		totalCount?: number;
		onSelect: (path: string | null) => void;
	} = $props();

	let expandedPaths = $state(new Set<string>());

	const ensureExpanded = (path: string | null, tree: ArchiveFolderNode[]) => {
		const next = new Set(expandedPaths);
		for (const node of tree) {
			next.add(node.path);
		}
		if (path) {
			const segments = path.split('/').filter(Boolean);
			let built = '';
			for (const segment of segments) {
				built = built ? `${built}/${segment}` : segment;
				next.add(built);
			}
		}
		expandedPaths = next;
	};

	$effect(() => {
		ensureExpanded(selectedPath, nodes);
	});

	const toggleExpanded = (path: string) => {
		const next = new Set(expandedPaths);
		if (next.has(path)) {
			next.delete(path);
		} else {
			next.add(path);
		}
		expandedPaths = next;
	};

	const isExpanded = (path: string) => expandedPaths.has(path);
</script>

{#snippet folderNode(node: ArchiveFolderNode, depth: number)}
	{@const hasChildren = node.children.length > 0}
	{@const expanded = isExpanded(node.path)}
	{@const selected = selectedPath === node.path}
	<div>
		<div
			class="flex min-w-0 items-center gap-0.5 rounded-md pr-1"
			style:padding-left={`${depth * 12 + 4}px`}
		>
			{#if hasChildren}
				<button
					type="button"
					class="text-muted-foreground hover:text-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-sm"
					onclick={() => toggleExpanded(node.path)}
					aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
				>
					{#if expanded}
						<ChevronDown class="h-3.5 w-3.5" />
					{:else}
						<ChevronRight class="h-3.5 w-3.5" />
					{/if}
				</button>
			{:else}
				<span class="inline-block h-6 w-6 shrink-0"></span>
			{/if}
			<button
				type="button"
				class={cn(
					'hover:bg-muted flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
					selected && 'bg-muted font-medium'
				)}
				onclick={() => onSelect(node.path)}
			>
				{#if selected || expanded}
					<FolderOpen class="text-muted-foreground h-4 w-4 shrink-0" />
				{:else}
					<Folder class="text-muted-foreground h-4 w-4 shrink-0" />
				{/if}
				<span class="truncate" title={node.name}>{node.name}</span>
				{#if node.count > 0}
					<span class="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums"
						>{node.count}</span
					>
				{/if}
			</button>
		</div>
		{#if hasChildren && expanded}
			{#each node.children as child (child.path)}
				{@render folderNode(child, depth + 1)}
			{/each}
		{/if}
	</div>
{/snippet}

<ScrollArea.Root class="h-full max-h-[calc(100vh-12rem)] rounded-md border">
	<div class="p-2">
		<button
			type="button"
			class={cn(
				'hover:bg-muted mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
				selectedPath == null && 'bg-muted font-medium'
			)}
			onclick={() => onSelect(null)}
		>
			<Inbox class="text-muted-foreground h-4 w-4 shrink-0" />
			<span class="truncate">{$t('app.archived_emails_page.all_mail')}</span>
			{#if totalCount > 0}
				<span class="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums"
					>{totalCount}</span
				>
			{/if}
		</button>
		{#each nodes as node (node.path)}
			{@render folderNode(node, 0)}
		{/each}
	</div>
</ScrollArea.Root>
