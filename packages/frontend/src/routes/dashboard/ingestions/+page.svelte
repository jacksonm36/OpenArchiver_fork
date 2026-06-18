<script lang="ts">
	import type { PageData } from './$types';
	import * as Table from '$lib/components/ui/table';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { MoreHorizontal, Trash, RefreshCw, ChevronRight, Activity, Play, FileDown } from 'lucide-svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Switch } from '$lib/components/ui/switch';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import IngestionSourceForm from '$lib/components/custom/IngestionSourceForm.svelte';
	import IngestionDiagnosticsDialog from '$lib/components/custom/IngestionDiagnosticsDialog.svelte';
	import IngestionProgressCell from '$lib/components/custom/IngestionProgressCell.svelte';
	import { api } from '$lib/api.client';
	import type { SafeIngestionSource, CreateIngestionSourceDto, IngestionDiagnostics, ResumeImportMode } from '@open-archiver/types';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { t } from '$lib/translations';

	let { data }: { data: PageData } = $props();
	let ingestionSources = $state(data.ingestionSources as SafeIngestionSource[]);
	let isDialogOpen = $state(false);
	let isDeleteDialogOpen = $state(false);
	let selectedSource = $state<SafeIngestionSource | null>(null);
	let sourceToDelete = $state<SafeIngestionSource | null>(null);
	let isDeleting = $state(false);
	let selectedIds = $state<string[]>([]);
	let isBulkDeleteDialogOpen = $state(false);
	let isUnmergeDialogOpen = $state(false);
	let sourceToUnmerge = $state<SafeIngestionSource | null>(null);
	let isUnmerging = $state(false);
	/** Tracks which root source groups are expanded in the table */
	let expandedGroups = $state<Set<string>>(new Set());
	let diagnosticsBySourceId = $state<Record<string, IngestionDiagnostics>>({});
	let diagnosticsSource = $state<SafeIngestionSource | null>(null);
	let isDiagnosticsOpen = $state(false);
	let ignoreCreateDialogOutside = $state(false);
	let createFormKey = $state(0);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let isPageVisible = $state(true);
	const POLL_INTERVAL_MS = 8000;
	const FILE_BASED_PROVIDERS = ['pst_import', 'eml_import', 'mbox_import'] as const;

	function canResumeSource(source: SafeIngestionSource): boolean {
		return (
			FILE_BASED_PROVIDERS.includes(source.provider as (typeof FILE_BASED_PROVIDERS)[number]) &&
			source.status === 'error'
		);
	}

	function exportGroupSourceId(source: SafeIngestionSource): string {
		return source.mergedIntoId ?? source.id;
	}

	async function downloadArchiveExport(
		source: SafeIngestionSource,
		format: 'mbox' | 'zip'
	): Promise<void> {
		if (!browser) return;
		const ingestionSourceId = exportGroupSourceId(source);
		const path =
			format === 'mbox'
				? `/archived-emails/export/mbox?ingestionSourceId=${encodeURIComponent(ingestionSourceId)}`
				: `/archived-emails/export/zip?ingestionSourceId=${encodeURIComponent(ingestionSourceId)}`;

		try {
			const response = await api(path);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const blob = await response.blob();
			const disposition = response.headers.get('Content-Disposition') ?? '';
			const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i);
			const fileName = decodeURIComponent(
				match?.[1] || match?.[2] || `${source.name}.${format === 'mbox' ? 'mbox' : 'zip'}`
			);
			const url = window.URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = fileName;
			document.body.appendChild(a);
			a.click();
			window.URL.revokeObjectURL(url);
			a.remove();
			setAlert({
				type: 'success',
				title: $t('app.ingestions.export_started'),
				message: fileName,
				duration: 4000,
				show: true,
			});
		} catch (error) {
			console.error('Export failed:', error);
			setAlert({
				type: 'error',
				title: $t('app.ingestions.export_failed'),
				message: String(error),
				duration: 5000,
				show: true,
			});
		}
	}

	async function handleResumeImport(id: string, mode: ResumeImportMode = 'import') {
		const res = await api(`/ingestion-sources/${id}/resume-import`, {
			method: 'POST',
			body: JSON.stringify({ mode }),
		});
		if (!res.ok) {
			const errorBody = await res.json();
			setAlert({
				type: 'error',
				title: $t('app.ingestions.resume_import_failed'),
				message: errorBody.message || JSON.stringify(errorBody),
				duration: 5000,
				show: true,
			});
			return;
		}
		setAlert({
			type: 'success',
			title: $t('app.ingestions.resume_import_success'),
			message: '',
			duration: 3000,
			show: true,
		});
		ingestionSources = ingestionSources.map((s) =>
			s.id === id ? { ...s, status: 'importing' as const } : s
		);
		await refreshSourcesAndDiagnostics();
	}

	const activeSourceIds = $derived(
		ingestionSources
			.filter((s) => ['importing', 'syncing', 'error'].includes(s.status))
			.map((s) => s.id)
	);

	async function fetchDiagnosticsForSources(ids: string[]) {
		const entries = await Promise.all(
			ids.map(async (id) => {
				const res = await api(`/ingestion-sources/${id}/diagnostics`);
				if (!res.ok) return null;
				return [id, (await res.json()) as IngestionDiagnostics] as const;
			})
		);
		const next = { ...diagnosticsBySourceId };
		for (const entry of entries) {
			if (entry) next[entry[0]] = entry[1];
		}
		diagnosticsBySourceId = next;
	}

	async function refreshSourcesAndDiagnostics() {
		const res = await api('/ingestion-sources');
		if (res.ok) {
			ingestionSources = await res.json();
		}
		const idsToPoll = ingestionSources
			.filter((s) => ['importing', 'syncing', 'error'].includes(s.status))
			.map((s) => s.id);
		if (idsToPoll.length > 0) {
			await fetchDiagnosticsForSources(idsToPoll);
		}
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function startPolling() {
		if (pollTimer || activeSourceIds.length === 0 || !isPageVisible) {
			return;
		}
		refreshSourcesAndDiagnostics();
		pollTimer = setInterval(refreshSourcesAndDiagnostics, POLL_INTERVAL_MS);
	}

	$effect(() => {
		if (activeSourceIds.length > 0 && isPageVisible) {
			startPolling();
		} else {
			stopPolling();
		}
	});

	onMount(() => {
		const handleVisibilityChange = () => {
			isPageVisible = document.visibilityState === 'visible';
			if (isPageVisible) {
				startPolling();
			} else {
				stopPolling();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});

	onDestroy(() => {
		stopPolling();
	});

	const openDiagnostics = (source: SafeIngestionSource) => {
		diagnosticsSource = source;
		isDiagnosticsOpen = true;
	};

	// Group sources: roots (mergedIntoId is null/undefined) and their children
	const rootSources = $derived(ingestionSources.filter((s) => !s.mergedIntoId));

	/** Returns children for a given root source ID */
	function getChildren(rootId: string): SafeIngestionSource[] {
		return ingestionSources.filter((s) => s.mergedIntoId === rootId);
	}

	/** Returns aggregated status for a group.
	 *  If the root is paused but children are still active, show 'active'
	 *  so the group does not appear fully paused when children are running. */
	function getGroupStatus(
		root: SafeIngestionSource,
		children: SafeIngestionSource[]
	): SafeIngestionSource['status'] {
		const all = [root, ...children];
		if (all.some((s) => s.status === 'error')) return 'error';
		if (all.some((s) => s.status === 'syncing')) return 'syncing';
		if (all.some((s) => s.status === 'importing')) return 'importing';
		if (all.every((s) => s.status === 'paused')) return 'paused';
		// Root paused but some children are active/imported — show active so the
		// group badge reflects that ingestion is still ongoing via the children.
		if (
			root.status === 'paused' &&
			children.some((s) => ['active', 'imported', 'syncing', 'importing'].includes(s.status))
		)
			return 'partially_active';
		if (all.every((s) => ['imported', 'active'].includes(s.status))) return 'active';
		return root.status;
	}

	const toggleGroup = (rootId: string) => {
		const next = new Set(expandedGroups);
		if (next.has(rootId)) {
			next.delete(rootId);
		} else {
			next.add(rootId);
		}
		expandedGroups = next;
	};

	const openCreateDialog = () => {
		selectedSource = null;
		createFormKey += 1;
		ignoreCreateDialogOutside = true;
		isDialogOpen = true;
		requestAnimationFrame(() => {
			ignoreCreateDialogOutside = false;
		});
	};

	const openEditDialog = (source: SafeIngestionSource) => {
		selectedSource = source as SafeIngestionSource;
		ignoreCreateDialogOutside = true;
		isDialogOpen = true;
		requestAnimationFrame(() => {
			ignoreCreateDialogOutside = false;
		});
	};

	const openDeleteDialog = (source: SafeIngestionSource) => {
		sourceToDelete = source;
		isDeleteDialogOpen = true;
	};

	/** Count of children that will be deleted alongside a root source */
	const deleteChildCount = $derived(
		sourceToDelete && !sourceToDelete.mergedIntoId ? getChildren(sourceToDelete.id).length : 0
	);

	const confirmDelete = async () => {
		if (!sourceToDelete) return;
		isDeleting = true;
		try {
			const res = await api(`/ingestion-sources/${sourceToDelete.id}`, { method: 'DELETE' });
			if (!res.ok) {
				const errorBody = await res.json();
				setAlert({
					type: 'error',
					title: 'Failed to delete ingestion',
					message: errorBody.message || JSON.stringify(errorBody),
					duration: 5000,
					show: true,
				});
				return;
			}
			// Remove the deleted source and any children from state
			const deletedId = sourceToDelete.id;
			ingestionSources = ingestionSources.filter(
				(s) => s.id !== deletedId && s.mergedIntoId !== deletedId
			);
			isDeleteDialogOpen = false;
			sourceToDelete = null;
		} finally {
			isDeleting = false;
		}
	};

	const handleSync = async (id: string) => {
		const res = await api(`/ingestion-sources/${id}/sync`, { method: 'POST' });
		if (!res.ok) {
			const errorBody = await res.json();
			setAlert({
				type: 'error',
				title: 'Failed to trigger force sync ingestion',
				message: errorBody.message || JSON.stringify(errorBody),
				duration: 5000,
				show: true,
			});
			return;
		}
		ingestionSources = ingestionSources.map((s) => {
			if (s.id === id) {
				return { ...s, status: 'syncing' as const };
			}
			return s;
		});
	};

	const handleToggle = async (source: SafeIngestionSource) => {
		try {
			const isPaused = source.status === 'paused';
			const newStatus = isPaused ? 'active' : 'paused';
			if (newStatus === 'paused') {
				const response = await api(`/ingestion-sources/${source.id}/pause`, {
					method: 'POST',
				});
				const responseText = await response.json();
				if (!response.ok) {
					throw Error(responseText.message || 'Operation failed');
				}
			} else {
				const response = await api(`/ingestion-sources/${source.id}`, {
					method: 'PUT',
					body: JSON.stringify({ status: 'active' }),
				});
				const responseText = await response.json();
				if (!response.ok) {
					throw Error(responseText.message || 'Operation failed');
				}
			}

			ingestionSources = ingestionSources.map((s) => {
				if (s.id === source.id) {
					return { ...s, status: newStatus };
				}
				return s;
			});
		} catch (e) {
			setAlert({
				type: 'error',
				title: 'Failed to trigger force sync ingestion',
				message: e instanceof Error ? e.message : JSON.stringify(e),
				duration: 5000,
				show: true,
			});
		}
	};

	const openUnmergeDialog = (source: SafeIngestionSource) => {
		sourceToUnmerge = source;
		isUnmergeDialogOpen = true;
	};

	const confirmUnmerge = async () => {
		if (!sourceToUnmerge) return;
		isUnmerging = true;
		try {
			const res = await api(`/ingestion-sources/${sourceToUnmerge.id}/unmerge`, {
				method: 'POST',
			});
			if (!res.ok) {
				const errorBody = await res.json();
				throw Error(errorBody.message || 'Unmerge failed');
			}
			const updated: SafeIngestionSource = await res.json();
			ingestionSources = ingestionSources.map((s) => (s.id === updated.id ? updated : s));
			isUnmergeDialogOpen = false;
			sourceToUnmerge = null;
			setAlert({
				type: 'success',
				title: $t('app.ingestions.unmerge_success'),
				message: '',
				duration: 3000,
				show: true,
			});
		} catch (e) {
			setAlert({
				type: 'error',
				title: 'Failed to unmerge',
				message: e instanceof Error ? e.message : JSON.stringify(e),
				duration: 5000,
				show: true,
			});
		} finally {
			isUnmerging = false;
		}
	};

	const handleBulkDelete = async () => {
		isDeleting = true;
		try {
			for (const id of selectedIds) {
				const res = await api(`/ingestion-sources/${id}`, { method: 'DELETE' });
				if (!res.ok) {
					const errorBody = await res.json();
					setAlert({
						type: 'error',
						title: `Failed to delete ingestion ${id}`,
						message: errorBody.message || JSON.stringify(errorBody),
						duration: 5000,
						show: true,
					});
					return;
				}
			}
			// Remove deleted roots and their children from local state
			// (backend cascades child deletion, so we mirror that here)
			ingestionSources = ingestionSources.filter(
				(s) => !selectedIds.includes(s.id) && !selectedIds.includes(s.mergedIntoId ?? '')
			);
			selectedIds = [];
			isBulkDeleteDialogOpen = false;
		} finally {
			isDeleting = false;
		}
	};

	const handleBulkForceSync = async () => {
		try {
			for (const id of selectedIds) {
				const res = await api(`/ingestion-sources/${id}/sync`, { method: 'POST' });
				if (!res.ok) {
					const errorBody = await res.json();
					setAlert({
						type: 'error',
						title: `Failed to trigger force sync for ingestion ${id}`,
						message: errorBody.message || JSON.stringify(errorBody),
						duration: 5000,
						show: true,
					});
				}
			}
			// Backend cascades force sync to non-file-based children,
			// so optimistically mark root + eligible children as syncing
			const fileBasedProviders = ['pst_import', 'eml_import', 'mbox_import'];
			ingestionSources = ingestionSources.map((s) => {
				// Mark selected roots as syncing
				if (selectedIds.includes(s.id)) {
					return { ...s, status: 'syncing' as const };
				}
				// Mark non-file-based children of selected roots as syncing
				if (
					s.mergedIntoId &&
					selectedIds.includes(s.mergedIntoId) &&
					!fileBasedProviders.includes(s.provider) &&
					(s.status === 'active' || s.status === 'error')
				) {
					return { ...s, status: 'syncing' as const };
				}
				return s;
			});
			selectedIds = [];
		} catch (e) {
			setAlert({
				type: 'error',
				title: 'Failed to trigger force sync',
				message: e instanceof Error ? e.message : JSON.stringify(e),
				duration: 5000,
				show: true,
			});
		}
	};

	const handleFormSubmit = async (formData: CreateIngestionSourceDto) => {
		try {
			if (selectedSource) {
				// Update
				const response = await api(`/ingestion-sources/${selectedSource.id}`, {
					method: 'PUT',
					body: JSON.stringify(formData),
				});
				if (!response.ok) {
					const errorData = await response.json();
					throw new Error(errorData.message || 'Failed to update source.');
				}
				const updatedSource = await response.json();
				ingestionSources = ingestionSources.map((s) =>
					s.id === updatedSource.id ? updatedSource : s
				);
			} else {
				// Create
				const response = await api('/ingestion-sources', {
					method: 'POST',
					body: JSON.stringify(formData),
				});
				if (!response.ok) {
					const errorData = await response.json();
					throw new Error(errorData.message || 'Failed to create source.');
				}
				const newSource = await response.json();
				ingestionSources = [...ingestionSources, newSource];
			}
			isDialogOpen = false;
		} catch (error) {
			let message = 'An unknown error occurred.';
			if (error instanceof Error) {
				message = error.message;
			}
			setAlert({
				type: 'error',
				title: selectedSource
					? $t('app.ingestions.edit')
					: $t('app.ingestions.create'),
				message,
				duration: 5000,
				show: true,
			});
		}
	};

	function getStatusClasses(status: SafeIngestionSource['status']): string {
		switch (status) {
			case 'active':
				return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
			case 'partially_active':
				return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
			case 'imported':
				return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
			case 'paused':
				return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
			case 'error':
				return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300';
			case 'syncing':
				return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300';
			case 'importing':
				return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300';
			case 'pending_auth':
				return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300';
			case 'auth_success':
				return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
			default:
				return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
		}
	}
</script>

<svelte:head>
	<title>{$t('app.ingestions.title')} - OpenArchiver</title>
</svelte:head>

<div class="">
	<div class="mb-4 flex items-center justify-between">
		<div class="flex items-center gap-4">
			<h1 class="text-2xl font-bold">{$t('app.ingestions.ingestion_sources')}</h1>
			{#if selectedIds.length > 0}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="outline">
								{$t('app.ingestions.bulk_actions')} ({selectedIds.length})
								<MoreHorizontal class="ml-2 h-4 w-4" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content>
						<DropdownMenu.Item onclick={handleBulkForceSync}>
							<RefreshCw class="mr-2 h-4 w-4" />
							{$t('app.ingestions.force_sync')}
						</DropdownMenu.Item>
						<DropdownMenu.Item
							class="text-red-600"
							onclick={() => (isBulkDeleteDialogOpen = true)}
						>
							<Trash class="mr-2 h-4 w-4" />
							{$t('app.ingestions.delete')}
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>
		<Button onclick={openCreateDialog}>{$t('app.ingestions.create_new')}</Button>
	</div>

	<div class="rounded-md border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-12">
						<Checkbox
							onCheckedChange={(checked) => {
								if (checked) {
									selectedIds = rootSources.map((s) => s.id);
								} else {
									selectedIds = [];
								}
							}}
							checked={rootSources.length > 0 &&
							selectedIds.length === rootSources.length
								? true
								: ((selectedIds.length > 0 ? 'indeterminate' : false) as any)}
						/>
					</Table.Head>
					<Table.Head>{$t('app.ingestions.name')}</Table.Head>
					<Table.Head>{$t('app.ingestions.provider')}</Table.Head>
					<Table.Head>{$t('app.ingestions.status')}</Table.Head>
					<Table.Head>{$t('app.ingestions.active')}</Table.Head>
					<Table.Head>{$t('app.ingestions.created_at')}</Table.Head>
					<Table.Head class="text-right">{$t('app.ingestions.actions')}</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#if rootSources.length > 0}
					{#each rootSources as source (source.id)}
						{@const children = getChildren(source.id)}
						{@const hasChildren = children.length > 0}
						{@const isExpanded = expandedGroups.has(source.id)}
						{@const displayStatus = hasChildren
							? getGroupStatus(source, children)
							: source.status}

						<!-- Root row -->
						<Table.Row>
							<Table.Cell>
								<Checkbox
									checked={selectedIds.includes(source.id)}
									onCheckedChange={() => {
										if (selectedIds.includes(source.id)) {
											selectedIds = selectedIds.filter(
												(id) => id !== source.id
											);
										} else {
											selectedIds = [...selectedIds, source.id];
										}
									}}
								/>
							</Table.Cell>
							<Table.Cell>
								<div class="flex items-center gap-1">
									{#if hasChildren}
										<button
											class="cursor-pointer rounded p-0.5 hover:bg-gray-100 dark:hover:bg-gray-800"
											onclick={() => toggleGroup(source.id)}
											aria-label={isExpanded
												? $t('app.ingestions.collapse')
												: $t('app.ingestions.expand')}
										>
											<ChevronRight
												class="h-4 w-4 transition-transform {isExpanded
													? 'rotate-90'
													: ''}"
											/>
										</button>
									{/if}
									<a
										class="link"
										href="/dashboard/archived-emails?ingestionSourceId={source.id}"
										>{source.name}</a
									>
									{#if hasChildren}
										<span class="text-muted-foreground ml-1 text-xs"
											>({children.length}
											{$t('app.ingestions.merged_sources')})</span
										>
									{/if}
								</div>
							</Table.Cell>
							<Table.Cell class="capitalize"
								>{source.provider.split('_').join(' ')}</Table.Cell
							>
							<Table.Cell class="min-w-32">
								<IngestionProgressCell
									status={displayStatus}
									diagnostics={diagnosticsBySourceId[source.id] ?? null}
									{getStatusClasses}
								/>
							</Table.Cell>
							<Table.Cell>
								<Switch
									id={`active-switch-${source.id}`}
									class="cursor-pointer"
									checked={source.status !== 'paused'}
									onCheckedChange={() => handleToggle(source)}
								/>
							</Table.Cell>
							<Table.Cell
								>{new Date(source.createdAt).toLocaleDateString()}</Table.Cell
							>
							<Table.Cell class="text-right">
								<div class="flex items-center justify-end gap-1">
									<Button
										variant="ghost"
										size="icon"
										class="h-8 w-8"
										title={$t('app.ingestions.diagnostics_title')}
										onclick={() => openDiagnostics(source)}
									>
										<Activity class="h-4 w-4" />
									</Button>
									<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button {...props} variant="ghost" class="h-8 w-8 p-0">
												<span class="sr-only"
													>{$t('app.ingestions.open_menu')}</span
												>
												<MoreHorizontal class="h-4 w-4" />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content>
										<DropdownMenu.Label
											>{$t('app.ingestions.actions')}</DropdownMenu.Label
										>
										<DropdownMenu.Item onclick={() => openEditDialog(source)}
											>{$t('app.ingestions.edit')}</DropdownMenu.Item
										>
										<DropdownMenu.Item onclick={() => openDiagnostics(source)}
											>{$t('app.ingestions.view_diagnostics')}</DropdownMenu.Item
										>
										{#if canResumeSource(source)}
											<DropdownMenu.Item onclick={() => handleResumeImport(source.id, 'dedup')}>
												<Play class="mr-2 h-4 w-4" />
												{$t('app.ingestions.resume_dedup')}
											</DropdownMenu.Item>
											<DropdownMenu.Item onclick={() => handleResumeImport(source.id, 'import')}>
												<Play class="mr-2 h-4 w-4" />
												{$t('app.ingestions.resume_import')}
											</DropdownMenu.Item>
										{/if}
										<DropdownMenu.Item onclick={() => handleSync(source.id)}
											>{$t('app.ingestions.force_sync')}</DropdownMenu.Item
										>
										<DropdownMenu.Separator />
										<DropdownMenu.Label
											>{$t('app.ingestions.export_eml_zip_hint')}</DropdownMenu.Label
										>
										<DropdownMenu.Item
											onclick={() => downloadArchiveExport(source, 'mbox')}
										>
											<FileDown class="mr-2 h-4 w-4" />
											{$t('app.ingestions.export_mbox')}
										</DropdownMenu.Item>
										<DropdownMenu.Item
											onclick={() => downloadArchiveExport(source, 'zip')}
										>
											<FileDown class="mr-2 h-4 w-4" />
											{$t('app.ingestions.export_eml_zip')}
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item
											class="text-red-600"
											onclick={() => openDeleteDialog(source)}
											>{$t('app.ingestions.delete')}</DropdownMenu.Item
										>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
								</div>
							</Table.Cell>
						</Table.Row>

						<!-- Child rows (shown when group is expanded) -->
						{#if hasChildren && isExpanded}
							{#each children as child (child.id)}
								<Table.Row class="bg-muted/30">
									<Table.Cell>
										<!-- No checkbox for children -->
									</Table.Cell>
									<Table.Cell>
										<div class="flex items-center gap-1 pl-6">
											<span class="text-muted-foreground mr-1">└</span>
											<!-- Child emails are stored under the root source — link to root -->
											<a
												class="link"
												href="/dashboard/archived-emails?ingestionSourceId={child.mergedIntoId}"
												>{child.name}</a
											>
										</div>
									</Table.Cell>
									<Table.Cell class="capitalize"
										>{child.provider.split('_').join(' ')}</Table.Cell
									>
									<Table.Cell class="min-w-32">
										<IngestionProgressCell
											status={child.status}
											diagnostics={diagnosticsBySourceId[child.id] ?? null}
											{getStatusClasses}
										/>
									</Table.Cell>
									<Table.Cell>
										<Switch
											id={`active-switch-${child.id}`}
											class="cursor-pointer"
											checked={child.status !== 'paused'}
											onCheckedChange={() => handleToggle(child)}
										/>
									</Table.Cell>
									<Table.Cell
										>{new Date(
											child.createdAt
										).toLocaleDateString()}</Table.Cell
									>
									<Table.Cell class="text-right">
										<div class="flex items-center justify-end gap-1">
											<Button
												variant="ghost"
												size="icon"
												class="h-8 w-8"
												title={$t('app.ingestions.diagnostics_title')}
												onclick={() => openDiagnostics(child)}
											>
												<Activity class="h-4 w-4" />
											</Button>
											<DropdownMenu.Root>
											<DropdownMenu.Trigger>
												{#snippet child({ props })}
													<Button
														{...props}
														variant="ghost"
														class="h-8 w-8 p-0"
													>
														<span class="sr-only"
															>{$t('app.ingestions.open_menu')}</span
														>
														<MoreHorizontal class="h-4 w-4" />
													</Button>
												{/snippet}
											</DropdownMenu.Trigger>
											<DropdownMenu.Content>
												<DropdownMenu.Label
													>{$t(
														'app.ingestions.actions'
													)}</DropdownMenu.Label
												>
												<DropdownMenu.Item
													onclick={() => openEditDialog(child)}
													>{$t('app.ingestions.edit')}</DropdownMenu.Item
												>
												<DropdownMenu.Item
													onclick={() => openDiagnostics(child)}
													>{$t('app.ingestions.view_diagnostics')}</DropdownMenu.Item
												>
												{#if canResumeSource(child)}
													<DropdownMenu.Item
														onclick={() => handleResumeImport(child.id, 'dedup')}
													>
														<Play class="mr-2 h-4 w-4" />
														{$t('app.ingestions.resume_dedup')}
													</DropdownMenu.Item>
													<DropdownMenu.Item
														onclick={() => handleResumeImport(child.id, 'import')}
													>
														<Play class="mr-2 h-4 w-4" />
														{$t('app.ingestions.resume_import')}
													</DropdownMenu.Item>
												{/if}
												<DropdownMenu.Item
													onclick={() => handleSync(child.id)}
													>{$t(
														'app.ingestions.force_sync'
													)}</DropdownMenu.Item
												>
												<DropdownMenu.Item
													onclick={() => openUnmergeDialog(child)}
												>
													{$t('app.ingestions.unmerge')}
												</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item
													class="text-red-600"
													onclick={() => openDeleteDialog(child)}
													>{$t(
														'app.ingestions.delete'
													)}</DropdownMenu.Item
												>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						{/if}
					{/each}
				{:else}
					<Table.Row>
						<Table.Cell class="h-8 text-center"></Table.Cell>
					</Table.Row>
				{/if}
			</Table.Body>
		</Table.Root>
	</div>
</div>

<Dialog.Root bind:open={isDialogOpen}>
	<Dialog.Content
		class="sm:max-w-120 md:max-w-180"
		onPointerDownOutside={(e) => {
			if (ignoreCreateDialogOutside) {
				e.preventDefault();
			}
		}}
		onInteractOutside={(e) => {
			if (ignoreCreateDialogOutside) {
				e.preventDefault();
			}
		}}
	>
		<Dialog.Header>
			<Dialog.Title
				>{selectedSource ? $t('app.ingestions.edit') : $t('app.ingestions.create')}{' '}
				{$t('app.ingestions.ingestion_source')}</Dialog.Title
			>
			<Dialog.Description>
				{selectedSource
					? $t('app.ingestions.edit_description')
					: $t('app.ingestions.create_description')}
				<span
					>{$t('app.ingestions.read')}{' '}
					<a
						class="text-primary underline underline-offset-2"
						target="_blank"
						href="https://docs.openarchiver.com/user-guides/email-providers/"
						>{$t('app.ingestions.docs_here')}</a
					>.</span
				>
			</Dialog.Description>
		</Dialog.Header>
		{#if isDialogOpen}
			{#key selectedSource?.id ?? `create-${createFormKey}`}
				<IngestionSourceForm
					source={selectedSource}
					existingSources={ingestionSources}
					onSubmit={handleFormSubmit}
				/>
			{/key}
		{/if}
	</Dialog.Content>
</Dialog.Root>
<Dialog.Root bind:open={isDeleteDialogOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{$t('app.ingestions.delete_confirmation_title')}</Dialog.Title>
			<Dialog.Description>
				{$t('app.ingestions.delete_confirmation_description')}
				{#if deleteChildCount > 0}
					<p class="mt-2 font-semibold text-red-600">
						{$t('app.ingestions.delete_root_warning', {
							count: deleteChildCount,
						} as any)}
					</p>
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="sm:justify-start">
			<Button
				type="button"
				variant="destructive"
				onclick={confirmDelete}
				disabled={isDeleting}
				>{#if isDeleting}
					{$t('app.ingestions.deleting')}...
				{:else}
					{$t('app.ingestions.confirm')}
				{/if}</Button
			>
			<Dialog.Close>
				<Button type="button" variant="secondary">{$t('app.ingestions.cancel')}</Button>
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
<Dialog.Root bind:open={isBulkDeleteDialogOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title
				>{$t('app.ingestions.bulk_delete_confirmation_title', {
					count: selectedIds.length,
				} as any)}</Dialog.Title
			>
			<Dialog.Description>
				{$t('app.ingestions.bulk_delete_confirmation_description')}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="sm:justify-start">
			<Button
				type="button"
				variant="destructive"
				onclick={handleBulkDelete}
				disabled={isDeleting}
				>{#if isDeleting}
					{$t('app.ingestions.deleting')}...
				{:else}
					{$t('app.ingestions.confirm')}
				{/if}</Button
			>
			<Dialog.Close>
				<Button type="button" variant="secondary">{$t('app.ingestions.cancel')}</Button>
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
<!-- Unmerge confirmation modal -->
<Dialog.Root bind:open={isUnmergeDialogOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{$t('app.ingestions.unmerge_confirmation_title')}</Dialog.Title>
			<Dialog.Description>
				{$t('app.ingestions.unmerge_confirmation_description')}
			</Dialog.Description>
		</Dialog.Header>
		<ul class="text-muted-foreground my-2 ml-4 list-disc space-y-1 text-sm">
			<li>{$t('app.ingestions.unmerge_warning_emails')}</li>
			<li>{$t('app.ingestions.unmerge_warning_future')}</li>
		</ul>
		<Dialog.Footer class="sm:justify-start">
			<Button type="button" variant="default" onclick={confirmUnmerge} disabled={isUnmerging}>
				{#if isUnmerging}
					{$t('app.ingestions.unmerging')}...
				{:else}
					{$t('app.ingestions.unmerge_confirm')}
				{/if}
			</Button>
			<Dialog.Close>
				<Button type="button" variant="secondary">{$t('app.ingestions.cancel')}</Button>
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<IngestionDiagnosticsDialog
	source={diagnosticsSource}
	bind:open={isDiagnosticsOpen}
	onResume={refreshSourcesAndDiagnostics}
/>