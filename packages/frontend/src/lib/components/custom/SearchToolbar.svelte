<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import Badge from '$lib/components/ui/badge/badge.svelte';
	import type { MatchingStrategy, SearchFieldScope, SearchFilters } from '@open-archiver/types';
	import { Paperclip, Tag, ChevronDown } from 'lucide-svelte';
	import { t } from '$lib/translations';

	let {
		keywords = $bindable(''),
		filters = $bindable<SearchFilters>({}),
		matchingStrategy = $bindable<MatchingStrategy>('last'),
		availableTags = [],
		onSearch,
	}: {
		keywords?: string;
		filters?: SearchFilters;
		matchingStrategy?: MatchingStrategy;
		availableTags?: string[];
		onSearch: () => void;
	} = $props();

	const strategies = $derived([
		{ value: 'last' as const, label: $t('app.search.strategy_fuzzy') },
		{ value: 'all' as const, label: $t('app.search.strategy_verbatim') },
		{ value: 'frequency' as const, label: $t('app.search.strategy_frequency') },
	]);

	const scopeOptions = $derived([
		{ value: 'from' as const, label: $t('app.search.scope_from') },
		{ value: 'to' as const, label: $t('app.search.scope_to') },
		{ value: 'subject' as const, label: $t('app.search.scope_subject') },
		{ value: 'body' as const, label: $t('app.search.scope_body') },
		{ value: 'attachments' as const, label: $t('app.search.scope_attachments') },
	]);

	const triggerContent = $derived(
		strategies.find((s) => s.value === matchingStrategy)?.label ??
			$t('app.search.select_strategy')
	);

	const activeScopes = $derived(filters.scopes ?? []);
	const selectedTags = $derived(filters.tags ?? []);

	function toggleScope(scope: SearchFieldScope) {
		const current = new Set(activeScopes);
		if (current.has(scope)) {
			current.delete(scope);
		} else {
			current.add(scope);
		}
		filters = {
			...filters,
			scopes: current.size > 0 ? [...current] : undefined,
		};
	}

	function isScopeActive(scope: SearchFieldScope) {
		return activeScopes.includes(scope);
	}

	function setFilterField<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) {
		const next = { ...filters };
		if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
			delete next[key];
		} else {
			next[key] = value;
		}
		filters = next;
	}

	function toggleTag(tag: string) {
		const current = new Set(selectedTags);
		if (current.has(tag)) {
			current.delete(tag);
		} else {
			current.add(tag);
		}
		setFilterField('tags', current.size > 0 ? [...current] : undefined);
	}

	function toggleAttachments() {
		setFilterField('hasAttachments', filters.hasAttachments ? undefined : true);
	}

	function clearFilters() {
		filters = {};
	}

	const hasFilters = $derived(
		Boolean(
			filters.from ||
				filters.to ||
				filters.cc ||
				filters.bcc ||
				filters.subject ||
				filters.body ||
				filters.dateFrom ||
				filters.dateTo ||
				filters.tags?.length ||
				filters.hasAttachments ||
				filters.scopes?.length
		)
	);
</script>

<form
	onsubmit={(e) => {
		e.preventDefault();
		onSearch();
	}}
	class="space-y-3"
>
	<div class="flex items-center gap-2">
		<Input
			type="search"
			name="keywords"
			placeholder={$t('app.search.placeholder')}
			class="h-11 flex-grow"
			bind:value={keywords}
		/>
		<Button type="submit" class="h-11 cursor-pointer">{$t('app.search.search_button')}</Button>
	</div>

	<div class="bg-muted/40 rounded-lg border p-3 space-y-3">
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-muted-foreground text-xs font-medium uppercase tracking-wide">
				{$t('app.search.search_in')}
			</span>
			{#each scopeOptions as scope (scope.value)}
				<Button
					type="button"
					variant={isScopeActive(scope.value) ? 'default' : 'outline'}
					size="sm"
					class="h-7 cursor-pointer text-xs"
					onclick={() => toggleScope(scope.value)}
				>
					{scope.label}
				</Button>
			{/each}
		</div>

		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			<div class="space-y-1">
				<Label for="search-from" class="text-xs">{$t('app.search.filter_from')}</Label>
				<Input
					id="search-from"
					type="text"
					placeholder={$t('app.search.filter_from_placeholder')}
					value={filters.from ?? ''}
					oninput={(e) => setFilterField('from', e.currentTarget.value || undefined)}
				/>
			</div>
			<div class="space-y-1">
				<Label for="search-to" class="text-xs">{$t('app.search.filter_to')}</Label>
				<Input
					id="search-to"
					type="text"
					placeholder={$t('app.search.filter_to_placeholder')}
					value={filters.to ?? ''}
					oninput={(e) => setFilterField('to', e.currentTarget.value || undefined)}
				/>
			</div>
			<div class="space-y-1">
				<Label for="search-subject" class="text-xs">{$t('app.search.filter_subject')}</Label>
				<Input
					id="search-subject"
					type="text"
					placeholder={$t('app.search.filter_subject_placeholder')}
					value={filters.subject ?? ''}
					oninput={(e) => setFilterField('subject', e.currentTarget.value || undefined)}
				/>
			</div>
			<div class="space-y-1">
				<Label for="search-body" class="text-xs">{$t('app.search.filter_body')}</Label>
				<Input
					id="search-body"
					type="text"
					placeholder={$t('app.search.filter_body_placeholder')}
					value={filters.body ?? ''}
					oninput={(e) => setFilterField('body', e.currentTarget.value || undefined)}
				/>
			</div>
			<div class="space-y-1">
				<Label for="search-date-from" class="text-xs">{$t('app.search.date_from')}</Label>
				<Input
					id="search-date-from"
					type="date"
					value={filters.dateFrom ?? ''}
					oninput={(e) => setFilterField('dateFrom', e.currentTarget.value || undefined)}
				/>
			</div>
			<div class="space-y-1">
				<Label for="search-date-to" class="text-xs">{$t('app.search.date_to')}</Label>
				<Input
					id="search-date-to"
					type="date"
					value={filters.dateTo ?? ''}
					oninput={(e) => setFilterField('dateTo', e.currentTarget.value || undefined)}
				/>
			</div>
		</div>

		<div class="flex flex-wrap items-center gap-2">
			<Button
				type="button"
				variant={filters.hasAttachments ? 'default' : 'outline'}
				size="sm"
				class="h-8 cursor-pointer gap-1.5"
				onclick={toggleAttachments}
			>
				<Paperclip class="h-3.5 w-3.5" />
				{$t('app.search.has_attachments')}
			</Button>

			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							type="button"
							variant={selectedTags.length > 0 ? 'default' : 'outline'}
							size="sm"
							class="h-8 cursor-pointer gap-1.5"
						>
							<Tag class="h-3.5 w-3.5" />
							{$t('app.search.tags')}
							{#if selectedTags.length > 0}
								<Badge variant="secondary" class="ml-1 h-5 px-1.5 text-[10px]">
									{selectedTags.length}
								</Badge>
							{/if}
							<ChevronDown class="h-3.5 w-3.5 opacity-60" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content class="w-64">
					<DropdownMenu.Label>{$t('app.search.select_tags')}</DropdownMenu.Label>
					{#if availableTags.length === 0}
						<DropdownMenu.Item disabled class="text-muted-foreground text-xs">
							{$t('app.search.no_tags')}
						</DropdownMenu.Item>
					{:else}
						{#each availableTags as tag (tag)}
							<DropdownMenu.CheckboxItem
								checked={selectedTags.includes(tag)}
								onCheckedChange={() => toggleTag(tag)}
							>
								{tag}
							</DropdownMenu.CheckboxItem>
						{/each}
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>

			{#if selectedTags.length > 0}
				<div class="flex flex-wrap gap-1">
					{#each selectedTags as tag (tag)}
						<Badge variant="outline" class="gap-1 text-xs">
							{tag}
							<button
								type="button"
								class="hover:text-destructive"
								onclick={() => toggleTag(tag)}
								aria-label={$t('app.search.remove_tag', { tag })}
							>
								×
							</button>
						</Badge>
					{/each}
				</div>
			{/if}

			{#if hasFilters}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="text-muted-foreground h-8 cursor-pointer text-xs"
					onclick={clearFilters}
				>
					{$t('app.search.clear_filters')}
				</Button>
			{/if}
		</div>
	</div>

	<div class="flex items-center gap-2">
		<span class="text-muted-foreground text-xs font-medium">{$t('app.search.search_options')}</span>
		<Select.Root type="single" name="matchingStrategy" bind:value={matchingStrategy}>
			<Select.Trigger class="h-8 w-[180px] cursor-pointer">
				{triggerContent}
			</Select.Trigger>
			<Select.Content>
				{#each strategies as strategy (strategy.value)}
					<Select.Item value={strategy.value} label={strategy.label} class="cursor-pointer">
						{strategy.label}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</div>
</form>
