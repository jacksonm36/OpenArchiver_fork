<script lang="ts">
	import type { SafeIngestionSource, CreateIngestionSourceDto } from '@open-archiver/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Switch } from '$lib/components/ui/switch';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as RadioGroup from '$lib/components/ui/radio-group/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { uploadFileWithProgress, formatUploadBytes } from '$lib/upload.client';
	import LocalImportFilePicker from '$lib/components/custom/LocalImportFilePicker.svelte';
	import { api } from '$lib/api.client';
	import { onMount } from 'svelte';
	import type { IImportSettings } from '@open-archiver/types';
	import { Progress } from '$lib/components/ui/progress';
	import { Loader2, Info, ChevronDown } from 'lucide-svelte';
	import tippy from 'tippy.js';
	import 'tippy.js/dist/tippy.css';
	import { t } from '$lib/translations';
	import type { IngestionProvider } from '@open-archiver/types';

	function createProviderConfig(provider: IngestionProvider): Record<string, unknown> {
		switch (provider) {
			case 'google_workspace':
				return { type: provider, serviceAccountKeyJson: '', impersonatedAdminEmail: '' };
			case 'microsoft_365':
				return { type: provider, clientId: '', clientSecret: '', tenantId: '' };
			case 'pst_import':
			case 'eml_import':
			case 'mbox_import':
				return {
					type: provider,
					localFilePath: '',
					uploadedFilePath: '',
					uploadedFileName: '',
				};
			default:
				return {
					type: 'generic_imap',
					host: '',
					port: 993,
					username: '',
					password: '',
					secure: true,
					allowInsecureCert: false,
				};
		}
	}

	function sanitizeProviderConfig(
		provider: IngestionProvider,
		config: Record<string, unknown>
	): Record<string, unknown> {
		const base = createProviderConfig(provider);
		const merged = { ...base, ...config };
		for (const key of Object.keys(base)) {
			const expected = base[key];
			const actual = merged[key];
			if (actual === null || actual === undefined) {
				merged[key] = expected;
			} else if (typeof expected === 'string' && typeof actual !== 'string') {
				merged[key] = String(actual);
			} else if (typeof expected === 'number' && typeof actual !== 'number') {
				const parsed = Number(actual);
				merged[key] = Number.isFinite(parsed) ? parsed : expected;
			} else if (typeof expected === 'boolean' && typeof actual !== 'boolean') {
				merged[key] = Boolean(actual);
			}
		}
		return merged;
	}

	function configStr(key: string): string {
		const value = providerConfig[key];
		return typeof value === 'string' ? value : '';
	}

	function setConfigStr(key: string, value: string) {
		providerConfig[key] = value;
	}

	function configNum(key: string, fallback: number): number {
		const value = providerConfig[key];
		return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
	}

	function setConfigNum(key: string, raw: string, fallback: number) {
		const parsed = Number.parseInt(raw, 10);
		providerConfig[key] = Number.isFinite(parsed) ? parsed : fallback;
	}

	const FILE_IMPORT_PROVIDERS = ['pst_import', 'eml_import', 'mbox_import'] as const;

	type FileImportProvider = (typeof FILE_IMPORT_PROVIDERS)[number];

	const FILE_IMPORT_META: Record<
		FileImportProvider,
		{ accept: string; placeholder: string; hintKey?: string }
	> = {
		pst_import: {
			accept: '.pst',
			placeholder: '/var/data/open-archiver/imports/archive.pst',
			hintKey: 'pst_large_file_hint',
		},
		eml_import: {
			accept: '.zip',
			placeholder: '/var/data/open-archiver/imports/archive.zip',
		},
		mbox_import: {
			accept: '.mbox',
			placeholder: '/var/data/open-archiver/imports/archive.mbox',
		},
	};

	function isFileImportProvider(provider: string): provider is FileImportProvider {
		return FILE_IMPORT_PROVIDERS.includes(provider as FileImportProvider);
	}

	let {
		source = null,
		existingSources = [],
		onSubmit,
	}: {
		source?: SafeIngestionSource | null;
		/** Existing root ingestion sources for the merge dropdown (create mode only) */
		existingSources?: SafeIngestionSource[];
		onSubmit: (data: CreateIngestionSourceDto) => Promise<void>;
	} = $props();

	const providerOptions = $derived([
		{
			value: 'generic_imap',
			label: $t('app.components.ingestion_source_form.provider_generic_imap'),
		},
		{
			value: 'google_workspace',
			label: $t('app.components.ingestion_source_form.provider_google_workspace'),
		},
		{
			value: 'microsoft_365',
			label: $t('app.components.ingestion_source_form.provider_microsoft_365'),
		},
		{
			value: 'pst_import',
			label: $t('app.components.ingestion_source_form.provider_pst_import'),
		},
		{
			value: 'eml_import',
			label: $t('app.components.ingestion_source_form.provider_eml_import'),
		},
		{
			value: 'mbox_import',
			label: $t('app.components.ingestion_source_form.provider_mbox_import'),
		},
	] as const);

	/** Only show root sources (not children) in the merge dropdown */
	const mergeableRootSources = $derived(existingSources.filter((s) => !s.mergedIntoId));

	const initialProvider = (source?.provider ?? 'generic_imap') as IngestionProvider;

	function initialProviderConfig(): Record<string, unknown> {
		if (source?.providerConfig && typeof source.providerConfig === 'object') {
			return sanitizeProviderConfig(
				initialProvider,
				source.providerConfig as Record<string, unknown>
			);
		}
		return createProviderConfig(initialProvider);
	}

	const initialConfig = initialProviderConfig();

	let name = $state(source?.name ?? '');
	let selectedProvider = $state<IngestionProvider>(initialProvider);
	let providerConfig = $state<Record<string, unknown>>(initialConfig);
	let localFilePath = $state(
		isFileImportProvider(initialProvider) && typeof initialConfig.localFilePath === 'string'
			? initialConfig.localFilePath
			: ''
	);
	let preserveOriginalFile = $state(Boolean(source?.preserveOriginalFile ?? false));
	let streamAttachmentsOnImport = $state(Boolean(source?.streamAttachmentsOnImport ?? true));
	let mergedIntoId = $state<string | undefined>(undefined);

	function buildFormData(): CreateIngestionSourceDto {
		const config = isFileImportProvider(selectedProvider)
			? { ...providerConfig, localFilePath }
			: providerConfig;
		return {
			name,
			provider: selectedProvider,
			providerConfig: config,
			preserveOriginalFile,
			streamAttachmentsOnImport,
			...(mergedIntoId ? { mergedIntoId } : {}),
		};
	}

	function setProvider(provider: IngestionProvider) {
		if (selectedProvider === provider) {
			return;
		}
		selectedProvider = provider;
		providerConfig = createProviderConfig(provider);
		if (isFileImportProvider(provider)) {
			localFilePath = '';
			importMethod = 'local';
			fileUploading = false;
			uploadProgress = null;
		}
	}

	function setImportMethod(method: 'upload' | 'local') {
		if (importMethod === method) {
			return;
		}
		importMethod = method;
		if (!isFileImportProvider(selectedProvider)) {
			return;
		}
		if (method === 'upload') {
			localFilePath = '';
		} else {
			providerConfig.uploadedFilePath = '';
			providerConfig.uploadedFileName = '';
		}
	}

	const triggerContent = $derived(
		providerOptions.find((p) => p.value === selectedProvider)?.label ??
			$t('app.components.ingestion_source_form.select_provider')
	);

	let isSubmitting = $state(false);
	let fileUploading = $state(false);
	let uploadProgress = $state<{ percent: number; loaded: number; total: number } | null>(null);
	let showAdvanced = $state(false);
	let mergeEnabled = $state(false);
	let importMethod = $state<'upload' | 'local'>('local');

	let importSettings = $state<IImportSettings | null>(null);

	const activeFileImportProvider = $derived(
		isFileImportProvider(selectedProvider) ? selectedProvider : null
	);

	const activeFileImportMeta = $derived(
		activeFileImportProvider ? FILE_IMPORT_META[activeFileImportProvider] : null
	);

	const activeFileImportFileLabel = $derived.by(() => {
		if (!activeFileImportProvider) {
			return '';
		}
		switch (activeFileImportProvider) {
			case 'pst_import':
				return $t('app.components.ingestion_source_form.pst_file');
			case 'eml_import':
				return $t('app.components.ingestion_source_form.eml_file');
			case 'mbox_import':
				return $t('app.components.ingestion_source_form.mbox_file');
		}
	});

	onMount(async () => {
		const res = await api('/ingestion-sources/import-settings');
		if (res.ok) {
			importSettings = await res.json();
			if (importSettings?.localPathOnly) {
				setImportMethod('local');
			}
		}
	});

	/** When merge is toggled off, clear the target source */
	function setMergeEnabled(enabled: boolean) {
		mergeEnabled = enabled === true;
		if (!mergeEnabled) {
			mergedIntoId = undefined;
			return;
		}
		if (!mergedIntoId && mergeableRootSources.length > 0) {
			mergedIntoId = mergeableRootSources[0].id;
		}
	}

	const handleSubmit = async (event: Event) => {
		event.preventDefault();

		const isFileImport = isFileImportProvider(selectedProvider);
		const useLocalPath =
			isFileImport && (importMethod === 'local' || importSettings?.localPathOnly);

		if (useLocalPath) {
			const path = localFilePath.trim();
			if (!path) {
				setAlert({
					type: 'error',
					title: $t('app.components.ingestion_source_form.local_path_required_title'),
					message: $t('app.components.ingestion_source_form.local_path_required'),
					duration: 8000,
					show: true,
				});
				return;
			}
		} else if (isFileImport && importMethod === 'upload') {
			const uploadedPath =
				typeof providerConfig.uploadedFilePath === 'string'
					? providerConfig.uploadedFilePath.trim()
					: '';
			if (!uploadedPath) {
				setAlert({
					type: 'error',
					title: $t('app.components.ingestion_source_form.upload_failed'),
					message: $t('app.components.ingestion_source_form.upload_file_required'),
					duration: 8000,
					show: true,
				});
				return;
			}
		}

		isSubmitting = true;
		try {
			await onSubmit(buildFormData());
		} finally {
			isSubmitting = false;
		}
	};

	const handleFileChange = async (event: Event) => {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) {
			return;
		}

		if (importSettings && importSettings.maxUploadMb > 0) {
			const maxBytes = importSettings.maxUploadMb * 1024 * 1024;
			if (file.size > maxBytes) {
				setAlert({
					type: 'error',
					title: $t('app.components.ingestion_source_form.upload_failed'),
					message: $t('app.components.ingestion_source_form.upload_too_large', {
						limit: importSettings.maxUploadMb,
						size: formatUploadBytes(file.size),
					}),
					duration: 10000,
					show: true,
				});
				target.value = '';
				return;
			}
		}

		fileUploading = true;
		uploadProgress = { percent: 0, loaded: 0, total: file.size };

		try {
			const result = await uploadFileWithProgress(file, (progress) => {
				uploadProgress = progress;
			});

			providerConfig.uploadedFilePath = result.filePath;
			providerConfig.uploadedFileName = file.name;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setAlert({
				type: 'error',
				title: $t('app.components.ingestion_source_form.upload_failed'),
				message,
				duration: 8000,
				show: true,
			});
			target.value = '';
		} finally {
			fileUploading = false;
			uploadProgress = null;
		}
	};

	const mergeTriggerContent = $derived(
		mergedIntoId
			? (mergeableRootSources.find((s) => s.id === mergedIntoId)?.name ??
					$t('app.components.ingestion_source_form.merge_into_select'))
			: $t('app.components.ingestion_source_form.merge_into_select')
	);
</script>

<form onsubmit={handleSubmit} class="grid gap-4 py-4">
	<div class="grid grid-cols-4 items-center gap-4">
		<Label for="name" class="text-left">{$t('app.ingestions.name')}</Label>
		<Input id="name" bind:value={name} class="col-span-3" />
	</div>
	<div class="grid grid-cols-4 items-center gap-4">
		<Label for="provider" class="text-left">{$t('app.ingestions.provider')}</Label>
		<Select.Root
			name="provider"
			type="single"
			value={selectedProvider}
			onValueChange={(value) => {
				if (value) {
					setProvider(value as IngestionProvider);
				}
			}}
		>
			<Select.Trigger class="col-span-3">
				{triggerContent}
			</Select.Trigger>
			<Select.Content>
				{#each providerOptions as option}
					<Select.Item value={option.value}>{option.label}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</div>

	{#key selectedProvider}
	{#if selectedProvider === 'google_workspace'}
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="serviceAccountKeyJson" class="text-left"
				>{$t('app.components.ingestion_source_form.service_account_key')}</Label
			>
			<Textarea
				placeholder={$t(
					'app.components.ingestion_source_form.service_account_key_placeholder'
				)}
				id="serviceAccountKeyJson"
				value={configStr('serviceAccountKeyJson')}
				oninput={(event) =>
					setConfigStr('serviceAccountKeyJson', event.currentTarget.value)}
				class="col-span-3 max-h-32"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="impersonatedAdminEmail" class="text-left"
				>{$t('app.components.ingestion_source_form.impersonated_admin_email')}</Label
			>
			<Input
				id="impersonatedAdminEmail"
				value={configStr('impersonatedAdminEmail')}
				oninput={(event) =>
					setConfigStr('impersonatedAdminEmail', event.currentTarget.value)}
				class="col-span-3"
			/>
		</div>
	{:else if selectedProvider === 'microsoft_365'}
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="clientId" class="text-left"
				>{$t('app.components.ingestion_source_form.client_id')}</Label
			>
			<Input
				id="clientId"
				value={configStr('clientId')}
				oninput={(event) => setConfigStr('clientId', event.currentTarget.value)}
				class="col-span-3"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="clientSecret" class="text-left"
				>{$t('app.components.ingestion_source_form.client_secret')}</Label
			>
			<Input
				id="clientSecret"
				type="password"
				placeholder={$t('app.components.ingestion_source_form.client_secret_placeholder')}
				value={configStr('clientSecret')}
				oninput={(event) => setConfigStr('clientSecret', event.currentTarget.value)}
				class="col-span-3"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="tenantId" class="text-left"
				>{$t('app.components.ingestion_source_form.tenant_id')}</Label
			>
			<Input
				id="tenantId"
				value={configStr('tenantId')}
				oninput={(event) => setConfigStr('tenantId', event.currentTarget.value)}
				class="col-span-3"
			/>
		</div>
	{:else if selectedProvider === 'generic_imap'}
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="host" class="text-left"
				>{$t('app.components.ingestion_source_form.host')}</Label
			>
			<Input
				id="host"
				value={configStr('host')}
				oninput={(event) => setConfigStr('host', event.currentTarget.value)}
				class="col-span-3"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="port" class="text-left"
				>{$t('app.components.ingestion_source_form.port')}</Label
			>
			<Input
				id="port"
				type="number"
				value={configNum('port', 993)}
				oninput={(event) => setConfigNum('port', event.currentTarget.value, 993)}
				class="col-span-3"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="username" class="text-left"
				>{$t('app.components.ingestion_source_form.username')}</Label
			>
			<Input
				id="username"
				value={configStr('username')}
				oninput={(event) => setConfigStr('username', event.currentTarget.value)}
				class="col-span-3"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="password" class="text-left">{$t('app.auth.password')}</Label>
			<Input
				id="password"
				type="password"
				value={configStr('password')}
				oninput={(event) => setConfigStr('password', event.currentTarget.value)}
				class="col-span-3"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="secure" class="text-left"
				>{$t('app.components.ingestion_source_form.use_tls')}</Label
			>
			<Checkbox
				id="secure"
				checked={providerConfig.secure === true}
				onCheckedChange={(checked) => {
					providerConfig.secure = checked === true;
				}}
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="allowInsecureCert" class="text-left"
				>{$t('app.components.ingestion_source_form.allow_insecure_cert')}</Label
			>
			<Checkbox
				id="allowInsecureCert"
				checked={providerConfig.allowInsecureCert === true}
				onCheckedChange={(checked) => {
					providerConfig.allowInsecureCert = checked === true;
				}}
			/>
		</div>
	{:else if activeFileImportProvider && activeFileImportMeta}
		{#if importSettings?.localPathOnly}
			<Alert.Root>
				<Alert.Title>{$t('app.components.ingestion_source_form.local_path_only_title')}</Alert.Title>
				<Alert.Description>
					{$t('app.components.ingestion_source_form.local_path_only_description')}
				</Alert.Description>
			</Alert.Root>
		{:else}
			<div class="grid grid-cols-4 items-start gap-4">
				<Label class="pt-2 text-left"
					>{$t('app.components.ingestion_source_form.import_method')}</Label
				>
				<RadioGroup.Root
					value={importMethod}
					onValueChange={(value) => {
						if (value === 'upload' || value === 'local') {
							setImportMethod(value);
						}
					}}
					class="col-span-3 flex flex-col space-y-1"
				>
					<div class="flex items-center space-x-2">
						<RadioGroup.Item value="upload" id="{activeFileImportProvider}-upload" />
						<Label for="{activeFileImportProvider}-upload"
							>{$t('app.components.ingestion_source_form.upload_file')}</Label
						>
					</div>
					<div class="flex items-center space-x-2">
						<RadioGroup.Item value="local" id="{activeFileImportProvider}-local" />
						<Label for="{activeFileImportProvider}-local"
							>{$t('app.components.ingestion_source_form.local_path')}</Label
						>
					</div>
				</RadioGroup.Root>
			</div>
		{/if}

		{#key `${activeFileImportProvider}-${importMethod}`}
			{#if importMethod === 'upload' && !importSettings?.localPathOnly}
				<div class="grid grid-cols-4 items-center gap-4">
					<Label for="{activeFileImportProvider}-file" class="text-left"
						>{activeFileImportFileLabel}</Label
					>
					<div class="col-span-3 space-y-2">
						<div class="flex flex-row items-center space-x-2">
							<Input
								id="{activeFileImportProvider}-file"
								type="file"
								accept={activeFileImportMeta.accept}
								onchange={handleFileChange}
								disabled={fileUploading}
							/>
							{#if fileUploading}
								<span class="text-primary animate-spin"><Loader2 /></span>
							{/if}
						</div>
						{#if uploadProgress}
							<div class="space-y-1">
								<Progress value={uploadProgress.percent} class="h-2" />
								<p class="text-muted-foreground text-xs">
									{$t('app.components.ingestion_source_form.upload_progress', {
										percent: uploadProgress.percent,
										loaded: formatUploadBytes(uploadProgress.loaded),
										total: formatUploadBytes(uploadProgress.total),
									})}
								</p>
							</div>
						{/if}
						{#if activeFileImportMeta.hintKey === 'pst_large_file_hint'}
							<p class="text-muted-foreground text-xs">
								{$t('app.components.ingestion_source_form.pst_large_file_hint')}
							</p>
						{/if}
					</div>
				</div>
			{:else}
				<div class="grid grid-cols-4 items-start gap-4">
					<Label for="{activeFileImportProvider}-local-path" class="pt-2 text-left"
						>{$t('app.components.ingestion_source_form.local_file_path')}</Label
					>
					<div class="col-span-3 space-y-3">
						<Input
							id="{activeFileImportProvider}-local-path"
							bind:value={localFilePath}
							placeholder={activeFileImportMeta.placeholder}
							required
						/>
						<LocalImportFilePicker
							provider={activeFileImportProvider}
							settings={importSettings}
							bind:value={localFilePath}
						/>
					</div>
				</div>
			{/if}
		{/key}
	{/if}
	{/key}
	{#if selectedProvider === 'google_workspace' || selectedProvider === 'microsoft_365'}
		<Alert.Root>
			<Alert.Title>{$t('app.components.ingestion_source_form.heads_up')}</Alert.Title>
			<Alert.Description>
				<div class="my-1">
					{@html $t('app.components.ingestion_source_form.org_wide_warning')}
				</div>
			</Alert.Description>
		</Alert.Root>
	{/if}

	<!-- Advanced Options (collapsible) -->
	<div class="border-t pt-2">
		<button
			type="button"
			class="text-muted-foreground flex w-full cursor-pointer items-center gap-1 text-sm font-medium"
			onclick={() => (showAdvanced = !showAdvanced)}
		>
			<ChevronDown class="h-4 w-4 transition-transform {showAdvanced ? 'rotate-180' : ''}" />
			{$t('app.components.ingestion_source_form.advanced_options')}
		</button>

		{#if showAdvanced}
			<div class="mt-3 grid gap-4">
				{#if isFileImportProvider(selectedProvider)}
					<div class="grid grid-cols-4 items-center gap-4">
						<div class="flex items-center gap-1 text-left">
							<Label for="streamAttachmentsOnImport"
								>{$t(
									'app.components.ingestion_source_form.stream_attachments_on_import'
								)}</Label
							>
							<span
								use:tippy={{
									allowHTML: true,
									content: $t(
										'app.components.ingestion_source_form.stream_attachments_on_import_tooltip'
									),
									interactive: true,
									delay: 500,
								}}
								class="text-muted-foreground cursor-help"
							>
								<Info class="h-4 w-4" />
							</span>
						</div>
						<Switch
							id="streamAttachmentsOnImport"
							checked={streamAttachmentsOnImport === true}
							onCheckedChange={(checked) => {
								streamAttachmentsOnImport = checked === true;
							}}
						/>
					</div>
				{/if}

				<div class="grid grid-cols-4 items-center gap-4">
					<div class="flex items-center gap-1 text-left">
						<Label for="preserveOriginalFile"
							>{$t(
								'app.components.ingestion_source_form.preserve_original_file'
							)}</Label
						>
						<span
							use:tippy={{
								allowHTML: true,
								content: $t(
									'app.components.ingestion_source_form.preserve_original_file_tooltip'
								),
								interactive: true,
								delay: 500,
							}}
							class="text-muted-foreground cursor-help"
						>
							<Info class="h-4 w-4" />
						</span>
					</div>
					<Checkbox
						id="preserveOriginalFile"
						checked={preserveOriginalFile === true}
						onCheckedChange={(checked) => {
							preserveOriginalFile = checked === true;
						}}
					/>
				</div>

				<!-- Merge into existing ingestion (create mode only, when existing sources exist) -->
				{#if !source && mergeableRootSources.length > 0}
					<div class="grid grid-cols-4 items-center gap-4">
						<div class="flex items-center gap-1 text-left">
							<Label for="mergeEnabled"
								>{$t('app.components.ingestion_source_form.merge_into')}</Label
							>
							<span
								use:tippy={{
									allowHTML: true,
									content: $t(
										'app.components.ingestion_source_form.merge_into_tooltip'
									),
									interactive: true,
									delay: 500,
								}}
								class="text-muted-foreground cursor-help"
							>
								<Info class="h-4 w-4" />
							</span>
						</div>
						<Checkbox
							id="mergeEnabled"
							checked={mergeEnabled}
							onCheckedChange={(checked) => {
								setMergeEnabled(checked);
							}}
						/>
					</div>

					{#if mergeEnabled && mergedIntoId}
						<div class="grid grid-cols-4 items-center gap-4">
							<div class="col-span-1"></div>
							<div class="col-span-3">
								<Select.Root
									name="mergedIntoId"
									value={mergedIntoId}
									onValueChange={(value) => {
										if (value) {
											mergedIntoId = value;
										}
									}}
									type="single"
								>
									<Select.Trigger class="w-full">
										{mergeTriggerContent}
									</Select.Trigger>
									<Select.Content>
										{#each mergeableRootSources as rootSource}
											<Select.Item value={rootSource.id}>
												{rootSource.name} ({rootSource.provider
													.split('_')
													.join(' ')})
											</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>

	<Dialog.Footer>
		<Button type="submit" disabled={isSubmitting || fileUploading}>
			{#if isSubmitting}
				{$t('app.components.common.submitting')}
			{:else}
				{$t('app.components.common.submit')}
			{/if}
		</Button>
	</Dialog.Footer>
</form>
