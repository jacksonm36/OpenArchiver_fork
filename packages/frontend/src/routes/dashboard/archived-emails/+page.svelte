<script lang="ts">
	import type { PageData } from './$types';
	import * as Table from '$lib/components/ui/table';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';
	import { goto } from '$app/navigation';
	import { t } from '$lib/translations';
	import * as Pagination from '$lib/components/ui/pagination/index.js';
	import ChevronLeft from 'lucide-svelte/icons/chevron-left';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import ArchiveFolderTree from '$lib/components/custom/ArchiveFolderTree.svelte';
	import FolderPathBreadcrumb from '$lib/components/custom/FolderPathBreadcrumb.svelte';

	let { data }: { data: PageData } = $props();

	let ingestionSources = $derived(data.ingestionSources);
	let archivedEmails = $derived(data.archivedEmails);
	let selectedIngestionSourceId = $derived(data.selectedIngestionSourceId);
	let folderTree = $derived(data.folderTree);
	let selectedFolderPath = $derived(data.selectedFolderPath);
	let allMailTotal = $derived(data.allMailTotal);
	let showFolderTree = $derived(folderTree.length > 0);

	const buildUrl = (params: { page?: number; path?: string | null; sourceId?: string }) => {
		const search = new URLSearchParams();
		const sourceId = params.sourceId ?? selectedIngestionSourceId;
		if (sourceId) {
			search.set('ingestionSourceId', sourceId);
		}
		if (params.path) {
			search.set('path', params.path);
		}
		const page = params.page ?? archivedEmails.page;
		if (page > 1) {
			search.set('page', String(page));
		}
		if (archivedEmails.limit !== 10) {
			search.set('limit', String(archivedEmails.limit));
		}
		const query = search.toString();
		return `/dashboard/archived-emails${query ? `?${query}` : ''}`;
	};

	const handleSourceChange = (value: string | undefined) => {
		if (value) {
			goto(buildUrl({ sourceId: value, path: null, page: 1 }));
		}
	};

	const handleFolderSelect = (path: string | null) => {
		goto(buildUrl({ path, page: 1 }));
	};
</script>

<svelte:head>
	<title>{$t('app.archived_emails_page.title')} - OpenArchiver</title>
</svelte:head>

<div class="mb-4 flex items-center justify-between">
	<h1 class="text-2xl font-bold">{$t('app.archived_emails_page.header')}</h1>
	{#if ingestionSources.length > 0}
		<div class="w-[250px]">
			<Select.Root
				type="single"
				onValueChange={handleSourceChange}
				value={selectedIngestionSourceId}
			>
				<Select.Trigger class="w-full">
					<span
						>{selectedIngestionSourceId
							? ingestionSources.find((s) => s.id === selectedIngestionSourceId)?.name
							: $t('app.archived_emails_page.select_ingestion_source')}</span
					>
				</Select.Trigger>
				<Select.Content>
					{#each ingestionSources as source}
						<Select.Item value={source.id}>{source.name}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
	{/if}
</div>

<div class={showFolderTree ? 'flex gap-4' : ''}>
	{#if showFolderTree}
		<aside class="w-72 shrink-0">
			<h2 class="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
				{$t('app.archived_emails_page.folders')}
			</h2>
			<ArchiveFolderTree
				nodes={folderTree}
				selectedPath={selectedFolderPath}
				totalCount={allMailTotal}
				onSelect={handleFolderSelect}
			/>
		</aside>
	{/if}

	<div class="min-w-0 flex-1">
		{#if selectedFolderPath}
			<div class="mb-3">
				<FolderPathBreadcrumb path={selectedFolderPath} />
			</div>
		{/if}

		<div class="rounded-md border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>{$t('app.archived_emails_page.date')}</Table.Head>
						<Table.Head>{$t('app.archived_emails_page.subject')}</Table.Head>
						<Table.Head>{$t('app.archived_emails_page.sender')}</Table.Head>
						<Table.Head>{$t('app.archived_emails_page.inbox')}</Table.Head>
						{#if !showFolderTree}
							<Table.Head>{$t('app.archived_emails_page.path')}</Table.Head>
						{/if}
						<Table.Head class="text-right">{$t('app.archived_emails_page.actions')}</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body class="text-sm">
					{#if archivedEmails.items.length > 0}
						{#each archivedEmails.items as email (email.id)}
							<Table.Row>
								<Table.Cell>{new Date(email.sentAt).toLocaleString()}</Table.Cell>

								<Table.Cell>
									<div class="max-w-100 truncate">
										<a class="link" href={`/dashboard/archived-emails/${email.id}`}>
											{email.subject}
										</a>
									</div>
								</Table.Cell>
								<Table.Cell>
									{email.senderEmail || email.senderName}
								</Table.Cell>
								<Table.Cell>{email.userEmail}</Table.Cell>
								{#if !showFolderTree}
									<Table.Cell>
										{#if email.path}
											<span class="bg-muted truncate rounded p-1.5 text-xs"
												>{email.path}
											</span>
										{/if}
									</Table.Cell>
								{/if}
								<Table.Cell class="text-right">
									<a href={`/dashboard/archived-emails/${email.id}`}>
										<Button variant="outline"
											>{$t('app.archived_emails_page.view')}</Button
										>
									</a>
								</Table.Cell>
							</Table.Row>
						{/each}
					{:else}
						<Table.Row>
							<Table.Cell colspan={showFolderTree ? 5 : 6} class="text-center"
								>{$t('app.archived_emails_page.no_emails_found')}</Table.Cell
							>
						</Table.Row>
					{/if}
				</Table.Body>
			</Table.Root>
		</div>

		{#if archivedEmails.total > archivedEmails.limit}
			<div class="mt-8">
				<Pagination.Root
					count={archivedEmails.total}
					perPage={archivedEmails.limit}
					page={archivedEmails.page}
				>
					{#snippet children({ pages, currentPage })}
						<Pagination.Content>
							<Pagination.Item>
								<a href={buildUrl({ page: currentPage - 1, path: selectedFolderPath })}>
									<Pagination.PrevButton>
										<ChevronLeft class="h-4 w-4" />
										<span class="hidden sm:block"
											>{$t('app.archived_emails_page.prev')}</span
										>
									</Pagination.PrevButton>
								</a>
							</Pagination.Item>
							{#each pages as page (page.key)}
								{#if page.type === 'ellipsis'}
									<Pagination.Item>
										<Pagination.Ellipsis />
									</Pagination.Item>
								{:else}
									<Pagination.Item>
										<a href={buildUrl({ page: page.value, path: selectedFolderPath })}>
											<Pagination.Link {page} isActive={currentPage === page.value}>
												{page.value}
											</Pagination.Link>
										</a>
									</Pagination.Item>
								{/if}
							{/each}
							<Pagination.Item>
								<a href={buildUrl({ page: currentPage + 1, path: selectedFolderPath })}>
									<Pagination.NextButton>
										<span class="hidden sm:block"
											>{$t('app.archived_emails_page.next')}</span
										>
										<ChevronRight class="h-4 w-4" />
									</Pagination.NextButton>
								</a>
							</Pagination.Item>
						</Pagination.Content>
					{/snippet}
				</Pagination.Root>
			</div>
		{/if}
	</div>
</div>
