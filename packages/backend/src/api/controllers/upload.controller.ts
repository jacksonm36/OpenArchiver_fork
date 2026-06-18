import { Request, Response } from 'express';

import { StorageService } from '../../services/StorageService';

import { randomUUID } from 'crypto';

import busboy from 'busboy';

import { config } from '../../config/index';

import { logger } from '../../config/logger';

import i18next from 'i18next';

import { sanitizeUploadFilename } from '../../helpers/sanitizeUploadFilename';

import { fileImportConfig } from '../../config/fileImport';



export const uploadFile = async (req: Request, res: Response) => {

	const storage = new StorageService();

	const uploads: Promise<void>[] = [];

	let filePath = '';

	let originalFilename = '';

	let headersSent = false;

	let filesReceived = 0;

	const contentLength = req.headers['content-length'];



	const sendErrorResponse = (statusCode: number, message: string) => {

		if (!headersSent) {

			headersSent = true;

			res.status(statusCode).json({

				status: 'error',

				statusCode,

				message,

				errors: null,

			});

		}

	};



	if (fileImportConfig.localPathOnly || fileImportConfig.maxUploadBytes === 0) {

		sendErrorResponse(

			403,

			'Browser uploads are disabled. Use server Local Path import for large PST/EML/Mbox files.'

		);

		return;

	}



	if (contentLength) {

		const size = parseInt(contentLength, 10);

		if (Number.isFinite(size) && size > fileImportConfig.maxUploadBytes) {

			sendErrorResponse(

				413,

				`File exceeds upload limit of ${fileImportConfig.maxUploadMb} MB. Use Local Path on the server instead.`

			);

			return;

		}

	}



	logger.info({ contentLength, contentType: req.headers['content-type'] }, 'File upload started');



	let bb: busboy.Busboy;

	try {

		bb = busboy({

			headers: req.headers,

			limits: {

				files: 1,

				fileSize: fileImportConfig.maxUploadBytes,

			},

		});

	} catch (err) {

		const message = err instanceof Error ? err.message : i18next.t('upload.invalid_request');

		logger.error({ error: message }, 'Failed to initialize file upload parser');

		sendErrorResponse(400, i18next.t('upload.invalid_request'));

		return;

	}



	bb.on('file', (fieldname, file, info) => {

		filesReceived += 1;

		if (filesReceived > 1) {

			file.resume();

			sendErrorResponse(400, 'Only one file may be uploaded per request.');

			return;

		}



		originalFilename = sanitizeUploadFilename(info.filename);

		const uuid = randomUUID();

		filePath = `${config.storage.openArchiverFolderName}/tmp/${uuid}-${originalFilename}`;



		logger.info({ filename: originalFilename, fieldname }, 'Receiving file stream');



		let bytesReceived = 0;

		file.on('data', (chunk: Buffer) => {

			bytesReceived += chunk.length;

			if (bytesReceived > fileImportConfig.maxUploadBytes) {

				file.destroy();

				sendErrorResponse(

					413,

					`File exceeds upload limit of ${fileImportConfig.maxUploadMb} MB. Use Local Path on the server instead.`

				);

			}

		});



		file.on('limit', () => {

			file.destroy();

			sendErrorResponse(

				413,

				`File exceeds upload limit of ${fileImportConfig.maxUploadMb} MB. Use Local Path on the server instead.`

			);

		});



		file.on('error', (err) => {

			logger.error(

				{ error: err.message, filename: originalFilename },

				'File stream error during upload'

			);

			sendErrorResponse(500, i18next.t('upload.stream_error'));

		});



		uploads.push(storage.put(filePath, file));

	});



	bb.on('error', (err: Error) => {

		logger.error({ error: err.message }, 'Upload parsing error');

		sendErrorResponse(500, i18next.t('upload.parse_error'));

	});



	bb.on('finish', async () => {

		if (filesReceived === 0) {

			sendErrorResponse(400, 'No file was uploaded.');

			return;

		}



		try {

			await Promise.all(uploads);

			if (!headersSent) {

				headersSent = true;

				logger.info(

					{ filePath, filename: originalFilename },

					'File upload completed successfully'

				);

				res.json({ filePath });

			}

		} catch (err) {

			const message = err instanceof Error ? err.message : 'Unknown storage error';

			logger.error(

				{ error: message, filename: originalFilename, filePath },

				'Failed to write uploaded file to storage'

			);

			sendErrorResponse(500, i18next.t('upload.storage_error'));

		}

	});



	req.on('error', (err) => {

		logger.warn(

			{ error: err.message, filename: originalFilename },

			'Client connection error during upload'

		);

		sendErrorResponse(499, i18next.t('upload.connection_error'));

	});



	req.on('aborted', () => {

		logger.warn({ filename: originalFilename }, 'Client aborted upload');

	});



	req.pipe(bb);

};


