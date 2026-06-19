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
				return { type: provider, localFilePath: '' };
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

	let formData: CreateIngestionSourceDto = $state({
		name: source?.name ?? '',
		provider: initialProvider,
		providerConfig: createProviderConfig(initialProvider),
		preserveOriginalFile: Boolean(source?.preserveOriginalFile ?? false),
		streamAttachmentsOnImport: Boolean(source?.streamAttachmentsOnImport ?? true),
	});

	function setProvider(provider: IngestionProvider) {
		if (formData.provider === provider) {
			return;
		}
		formData.provider = provider;
		formData.providerConfig = createProviderConfig(provider);
	}

	const triggerContent = $derived(
		providerOptions.find((p) => p.value === formData.provider)?.label ??
			$t('app.components.ingestion_source_form.select_provider')
	);

	let isSubmitting = $state(false);
	let fileUploading = $state(false);
	let uploadProgress = $state<{ percent: number; loaded: number; total: number } | null>(null);
	let showAdvanced = $state(false);
	let mergeEnabled = $state(false);
	let importMethod = $state<'upload' | 'local'>('local');

	const FILE_IMPORT_PROVIDERS = ['pst_import', 'eml_import', 'mbox_import'] as const;

	let importSettings = $state<IImportSettings | null>(null);
	let previousFileImportProvider = $state<string | null>(null);

	onMount(async () => {
		const res = await api('/ingestion-sources/import-settings');
		if (res.ok) {
			importSettings = await res.json();
			if (importSettings?.localPathOnly) {
				importMethod = 'local';
			}
		}
	});

	$effect(() => {
		const provider = formData.provider;
		if (
			!source &&
			FILE_IMPORT_PROVIDERS.includes(provider as (typeof FILE_IMPORT_PROVIDERS)[number]) &&
			provider !== previousFileImportProvider
		) {
			previousFileImportProvider = provider;
			if (importSettings?.localPathOnly) {
				importMethod = 'local';
			}
		}
	});

	/** When merge is toggled off, clear the mergedIntoId */
	$effect(() => {
		if (!mergeEnabled) {
			delete formData.mergedIntoId;
		}
	});

	$effect(() => {
		if (importMethod === 'upload') {
			if ('localFilePath' in formData.providerConfig) {
				delete formData.providerConfig.localFilePath;
			}
		} else {
			if ('uploadedFilePath' in formData.providerConfig) {
				delete formData.providerConfig.uploadedFilePath;
			}
			if ('uploadedFileName' in formData.providerConfig) {
				delete formData.providerConfig.uploadedFileName;
			}
		}
	});

	const handleSubmit = async (event: Event) => {
		event.preventDefault();

		const isFileImport = FILE_IMPORT_PROVIDERS.includes(
			formData.provider as (typeof FILE_IMPORT_PROVIDERS)[number]
		);
		const useLocalPath =
			isFileImport && (importMethod === 'local' || importSettings?.localPathOnly);

		if (useLocalPath) {
			const localPath =
				'localFilePath' in formData.providerConfig
					? formData.providerConfig.localFilePath?.trim()
					: '';
			if (!localPath) {
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
				'uploadedFilePath' in formData.providerConfig
					? formData.providerConfig.uploadedFilePath?.trim()
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
			await onSubmit(formData);
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

			formData.providerConfig.uploadedFilePath = result.filePath;
			formData.providerConfig.uploadedFileName = file.name;
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
		formData.mergedIntoId
			? (mergeableRootSources.find((s) => s.id === formData.mergedIntoId)?.name ??
					$t('app.components.ingestion_source_form.merge_into_select'))
			: $t('app.components.ingestion_source_form.merge_into_select')
	);
</script>

<form onsubmit={handleSubmit} class="grid gap-4 py-4">
	<div class="grid grid-cols-4 items-center gap-4">
		<Label for="name" class="text-left">{$t('app.ingestions.name')}</Label>
		<Input id="name" bind:value={formData.name} class="col-span-3" />
	</div>
	<div class="grid grid-cols-4 items-center gap-4">
		<Label for="provider" class="text-left">{$t('app.ingestions.provider')}</Label>
		<Select.Root
			name="provider"
			type="single"
			value={formData.provider}
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

	{#key formData.provider}
	{#if formData.provider === 'google_workspace'}
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="serviceAccountKeyJson" class="text-left"
				>{$t('app.components.ingestion_source_form.service_account_key')}</Label
			>
			<Textarea
				placeholder={$t(
					'app.components.ingestion_source_form.service_account_key_placeholder'
				)}
				id="serviceAccountKeyJson"
				bind:value={formData.providerConfig.serviceAccountKeyJson}
				class="col-span-3 max-h-32"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="impersonatedAdminEmail" class="text-left"
				>{$t('app.components.ingestion_source_form.impersonated_admin_email')}</Label
			>
			<Input
				id="impersonatedAdminEmail"
				bind:value={formData.providerConfig.impersonatedAdminEmail}
				class="col-span-3"
			/>
		</div>
	{:else if formData.provider === 'microsoft_365'}
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="clientId" class="text-left"
				>{$t('app.components.ingestion_source_form.client_id')}</Label
			>
			<Input id="clientId" bind:value={formData.providerConfig.clientId} class="col-span-3" />
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="clientSecret" class="text-left"
				>{$t('app.components.ingestion_source_form.client_secret')}</Label
			>
			<Input
				id="clientSecret"
				type="password"
				placeholder={$t('app.components.ingestion_source_form.client_secret_placeholder')}
				bind:value={formData.providerConfig.clientSecret}
				class="col-span-3"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="tenantId" class="text-left"
				>{$t('app.components.ingestion_source_form.tenant_id')}</Label
			>
			<Input id="tenantId" bind:value={formData.providerConfig.tenantId} class="col-span-3" />
		</div>
	{:else if formData.provider === 'generic_imap'}
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="host" class="text-left"
				>{$t('app.components.ingestion_source_form.host')}</Label
			>
			<Input id="host" bind:value={formData.providerConfig.host} class="col-span-3" />
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="port" class="text-left"
				>{$t('app.components.ingestion_source_form.port')}</Label
			>
			<Input
				id="port"
				type="number"
				bind:value={formData.providerConfig.port}
				class="col-span-3"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="username" class="text-left"
				>{$t('app.components.ingestion_source_form.username')}</Label
			>
			<Input id="username" bind:value={formData.providerConfig.username} class="col-span-3" />
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="password" class="text-left">{$t('app.auth.password')}</Label>
			<Input
				id="password"
				type="password"
				bind:value={formData.providerConfig.password}
				class="col-span-3"
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="secure" class="text-left"
				>{$t('app.components.ingestion_source_form.use_tls')}</Label
			>
			<Checkbox
				id="secure"
				checked={formData.providerConfig.secure === true}
				onCheckedChange={(checked) => {
					formData.providerConfig.secure = checked;
				}}
			/>
		</div>
		<div class="grid grid-cols-4 items-center gap-4">
			<Label for="allowInsecureCert" class="text-left"
				>{$t('app.components.ingestion_source_form.allow_insecure_cert')}</Label
			>
			<Checkbox
				id="allowInsecureCert"
				checked={formData.providerConfig.allowInsecureCert === true}
				onCheckedChange={(checked) => {
					formData.providerConfig.allowInsecureCert = checked;
				}}
			/>
		</div>
	{:else if formData.provider === 'pst_import'}
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
				<RadioGroup.Root bind:value={importMethod} class="col-span-3 flex flex-col space-y-1">
					<div class="flex items-center space-x-2">
						<RadioGroup.Item value="upload" id="pst-upload" />
						<Label for="pst-upload"
							>{$t('app.components.ingestion_source_form.upload_file')}</Label
						>
					</div>
					<div class="flex items-center space-x-2">
						<RadioGroup.Item value="local" id="pst-local" />
						<Label for="pst-local"
							>{$t('app.components.ingestion_source_form.local_path')}</Label
						>
					</div>
				</RadioGroup.Root>
			</div>
		{/if}

		{#if importMethod === 'upload' && !importSettings?.localPathOnly}
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="pst-file" class="text-left"
					>{$t('app.components.ingestion_source_form.pst_file')}</Label
				>
				<div class="col-span-3 space-y-2">
					<div class="flex flex-row items-center space-x-2">
						<Input
							id="pst-file"
							type="file"
							accept=".pst"
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
					<p class="text-muted-foreground text-xs">
						{$t('app.components.ingestion_source_form.pst_large_file_hint')}
					</p>
				</div>
			</div>
		{:else}
			<div class="grid grid-cols-4 items-start gap-4">
				<Label for="pst-local-path" class="pt-2 text-left"
					>{$t('app.components.ingestion_source_form.local_file_path')}</Label
				>
				<div class="col-span-3 space-y-3">
					<Input
						id="pst-local-path"
						bind:value={formData.providerConfig.localFilePath}
						placeholder="/var/data/open-archiver/imports/archive.pst"
						required
					/>
					<LocalImportFilePicker
						provider="pst_import"
						settings={importSettings}
						bind:value={formData.providerConfig.localFilePath}
					/>
				</div>
			</div>
		{/if}
	{:else if formData.provider === 'eml_import'}
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
				<RadioGroup.Root bind:value={importMethod} class="col-span-3 flex flex-col space-y-1">
					<div class="flex items-center space-x-2">
						<RadioGroup.Item value="upload" id="eml-upload" />
						<Label for="eml-upload"
							>{$t('app.components.ingestion_source_form.upload_file')}</Label
						>
					</div>
					<div class="flex items-center space-x-2">
						<RadioGroup.Item value="local" id="eml-local" />
						<Label for="eml-local"
							>{$t('app.components.ingestion_source_form.local_path')}</Label
						>
					</div>
				</RadioGroup.Root>
			</div>
		{/if}

		{#if importMethod === 'upload' && !importSettings?.localPathOnly}
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="eml-file" class="text-left"
					>{$t('app.components.ingestion_source_form.eml_file')}</Label
				>
				<div class="col-span-3 flex flex-row items-center space-x-2">
					<Input
						id="eml-file"
						type="file"
						class=""
						accept=".zip"
						onchange={handleFileChange}
					/>
					{#if fileUploading}
						<span class=" text-primary animate-spin"><Loader2 /></span>
					{/if}
				</div>
			</div>
		{:else}
			<div class="grid grid-cols-4 items-start gap-4">
				<Label for="eml-local-path" class="pt-2 text-left"
					>{$t('app.components.ingestion_source_form.local_file_path')}</Label
				>
				<div class="col-span-3 space-y-3">
					<Input
						id="eml-local-path"
						bind:value={formData.providerConfig.localFilePath}
						placeholder="/var/data/open-archiver/imports/archive.zip"
						required
					/>
					<LocalImportFilePicker
						provider="eml_import"
						settings={importSettings}
						bind:value={formData.providerConfig.localFilePath}
					/>
				</div>
			</div>
		{/if}
	{:else if formData.provider === 'mbox_import'}
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
				<RadioGroup.Root bind:value={importMethod} class="col-span-3 flex flex-col space-y-1">
					<div class="flex items-center space-x-2">
						<RadioGroup.Item value="upload" id="mbox-upload" />
						<Label for="mbox-upload"
							>{$t('app.components.ingestion_source_form.upload_file')}</Label
						>
					</div>
					<div class="flex items-center space-x-2">
						<RadioGroup.Item value="local" id="mbox-local" />
						<Label for="mbox-local"
							>{$t('app.components.ingestion_source_form.local_path')}</Label
						>
					</div>
				</RadioGroup.Root>
			</div>
		{/if}

		{#if importMethod === 'upload' && !importSettings?.localPathOnly}
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="mbox-file" class="text-left"
					>{$t('app.components.ingestion_source_form.mbox_file')}</Label
				>
				<div class="col-span-3 flex flex-row items-center space-x-2">
					<Input
						id="mbox-file"
						type="file"
						class=""
						accept=".mbox"
						onchange={handleFileChange}
					/>
					{#if fileUploading}
						<span class=" text-primary animate-spin"><Loader2 /></span>
					{/if}
				</div>
			</div>
		{:else}
			<div class="grid grid-cols-4 items-start gap-4">
				<Label for="mbox-local-path" class="pt-2 text-left"
					>{$t('app.components.ingestion_source_form.local_file_path')}</Label
				>
				<div class="col-span-3 space-y-3">
					<Input
						id="mbox-local-path"
						bind:value={formData.providerConfig.localFilePath}
						placeholder="/var/data/open-archiver/imports/archive.mbox"
						required
					/>
					<LocalImportFilePicker
						provider="mbox_import"
						settings={importSettings}
						bind:value={formData.providerConfig.localFilePath}
					/>
				</div>
			</div>
		{/if}
		{/if}
	{/key}
	{#if formData.provider === 'google_workspace' || formData.provider === 'microsoft_365'}
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
				{#if FILE_IMPORT_PROVIDERS.includes(formData.provider as (typeof FILE_IMPORT_PROVIDERS)[number])}
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
							checked={formData.streamAttachmentsOnImport === true}
							onCheckedChange={(checked) => {
								formData.streamAttachmentsOnImport = checked;
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
						checked={formData.preserveOriginalFile === true}
						onCheckedChange={(checked) => {
							formData.preserveOriginalFile = checked;
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
								mergeEnabled = checked;
							}}
						/>
					</div>

					{#if mergeEnabled}
						<div class="grid grid-cols-4 items-center gap-4">
							<div class="col-span-1"></div>
							<div class="col-span-3">
								<Select.Root
									name="mergedIntoId"
									value={formData.mergedIntoId ?? ''}
									onValueChange={(value) => {
										formData.mergedIntoId = value || undefined;
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
