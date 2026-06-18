import { Request, Response } from 'express';
import { IngestionService } from '../../services/IngestionService';
import {
	CreateIngestionSourceDto,
	UpdateIngestionSourceDto,
	IngestionSource,
	SafeIngestionSource,
	ResumeImportDto,
} from '@open-archiver/types';
import { logger } from '../../config/logger';
import { UserService } from '../../services/UserService';
import { checkDeletionEnabled } from '../../helpers/deletionGuard';
import { LocalImportService } from '../../services/LocalImportService';
import type { IngestionProvider } from '@open-archiver/types';

export class IngestionController {
	private userService = new UserService();
	private localImportService = new LocalImportService();
	/**
	 * Converts an IngestionSource object to a safe version for client-side consumption
	 * by removing the credentials.
	 * @param source The full IngestionSource object.
	 * @returns An object conforming to the SafeIngestionSource type.
	 */
	private toSafeIngestionSource(source: IngestionSource): SafeIngestionSource {
		const { credentials, ...safeSource } = source;
		return safeSource;
	}

	public create = async (req: Request, res: Response): Promise<Response> => {
		try {
			const dto: CreateIngestionSourceDto = req.body;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const newSource = await IngestionService.create(
				dto,
				userId,
				actor,
				req.ip || 'unknown'
			);
			const safeSource = this.toSafeIngestionSource(newSource);
			return res.status(201).json(safeSource);
		} catch (error: any) {
			logger.error({ err: error }, 'Create ingestion source error');
			// Return a 400 Bad Request for connection errors
			return res.status(400).json({
				message: error.message || req.t('ingestion.failedToCreate'),
			});
		}
	};

	public findAll = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const sources = await IngestionService.findAll(userId);
			const safeSources = sources.map(this.toSafeIngestionSource);
			return res.status(200).json(safeSources);
		} catch (error) {
			console.error('Find all ingestion sources error:', error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public findById = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const source = await IngestionService.findByIdForUser(id, userId);
			const safeSource = this.toSafeIngestionSource(source);
			return res.status(200).json(safeSource);
		} catch (error) {
			console.error(`Find ingestion source by id ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public update = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const dto: UpdateIngestionSourceDto = req.body;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const updatedSource = await IngestionService.update(
				id,
				dto,
				actor,
				req.ip || 'unknown'
			);
			const safeSource = this.toSafeIngestionSource(updatedSource);
			return res.status(200).json(safeSource);
		} catch (error) {
			console.error(`Update ingestion source ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public delete = async (req: Request, res: Response): Promise<Response> => {
		try {
			checkDeletionEnabled();
			const { id } = req.params;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			await IngestionService.delete(id, actor, req.ip || 'unknown');
			return res.status(204).send();
		} catch (error) {
			console.error(`Delete ingestion source ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			} else if (error instanceof Error) {
				return res.status(400).json({ message: error.message });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public triggerInitialImport = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			await IngestionService.triggerInitialImport(id);
			return res.status(202).json({ message: req.t('ingestion.initialImportTriggered') });
		} catch (error) {
			console.error(`Trigger initial import for ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public resumeImport = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const dto = (req.body ?? {}) as ResumeImportDto;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			await IngestionService.triggerResumeImport(
				id,
				dto.mode ?? 'import',
				actor,
				req.ip || 'unknown'
			);
			return res.status(202).json({ message: req.t('ingestion.resumeImportTriggered') });
		} catch (error) {
			logger.error({ err: error }, `Resume import for ${req.params.id} error`);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			if (error instanceof Error) {
				return res.status(400).json({ message: error.message });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public pause = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const updatedSource = await IngestionService.update(
				id,
				{ status: 'paused' },
				actor,
				req.ip || 'unknown'
			);
			const safeSource = this.toSafeIngestionSource(updatedSource);
			return res.status(200).json(safeSource);
		} catch (error) {
			console.error(`Pause ingestion source ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public unmerge = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const updatedSource = await IngestionService.unmerge(id, actor, req.ip || 'unknown');
			const safeSource = this.toSafeIngestionSource(updatedSource);
			return res.status(200).json(safeSource);
		} catch (error) {
			logger.error({ err: error }, `Unmerge ingestion source ${req.params.id} error`);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			} else if (error instanceof Error) {
				return res.status(400).json({ message: error.message });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getDiagnostics = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const diagnostics = await IngestionService.getDiagnostics(id, userId);
			return res.status(200).json(diagnostics);
		} catch (error) {
			logger.error({ err: error }, `Get diagnostics for ${req.params.id} error`);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public triggerForceSync = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			await IngestionService.triggerForceSync(id, actor, req.ip || 'unknown');
			return res.status(202).json({ message: req.t('ingestion.forceSyncTriggered') });
		} catch (error) {
			console.error(`Trigger force sync for ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getImportSettings = async (_req: Request, res: Response): Promise<Response> => {
		try {
			return res.status(200).json(this.localImportService.getSettings());
		} catch (error) {
			logger.error({ err: error }, 'Get import settings error');
			return res.status(500).json({ message: 'Failed to load import settings' });
		}
	};

	public listImportFiles = async (req: Request, res: Response): Promise<Response> => {
		try {
			const provider = req.query.provider as IngestionProvider | undefined;
			const directory = typeof req.query.directory === 'string' ? req.query.directory : undefined;

			if (!provider || !['pst_import', 'eml_import', 'mbox_import'].includes(provider)) {
				return res.status(400).json({ message: 'Invalid or missing provider query parameter' });
			}

			const listing = await this.localImportService.listDirectory(provider, directory);
			return res.status(200).json(listing);
		} catch (error) {
			logger.error({ err: error }, 'List import files error');
			return res.status(400).json({
				message: 'Failed to list import files',
			});
		}
	};
}
