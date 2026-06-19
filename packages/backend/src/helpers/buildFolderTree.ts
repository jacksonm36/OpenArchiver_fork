import type { ArchiveFolderNode } from '@open-archiver/types';

export interface FolderPathCount {
	path: string;
	count: number;
}

/**
 * Builds a hierarchical folder tree from flat path/count rows (PST/IMAP folder paths).
 */
export function buildFolderTree(entries: FolderPathCount[]): ArchiveFolderNode[] {
	const roots: ArchiveFolderNode[] = [];

	for (const { path, count } of entries) {
		const segments = path.split('/').filter((segment) => segment.length > 0);
		if (segments.length === 0) {
			continue;
		}

		let level = roots;
		let builtPath = '';

		for (let i = 0; i < segments.length; i++) {
			const name = segments[i];
			builtPath = builtPath ? `${builtPath}/${name}` : name;

			let node = level.find((entry) => entry.name === name);
			if (!node) {
				node = { name, path: builtPath, count: 0, children: [] };
				level.push(node);
			}

			if (i === segments.length - 1) {
				node.count = count;
			}

			level = node.children;
		}
	}

	const sortNodes = (nodes: ArchiveFolderNode[]) => {
		nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};

	sortNodes(roots);
	return roots;
}
