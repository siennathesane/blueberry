/**
 * The project registry: the mapping between stable project identities and
 * the messy physical world (paths that move, repos that get re-cloned).
 *
 * Invariants:
 * - registry.json is *convenience*, rebuildable from session headers + markers
 *   (bb doctor proves this). Losing it is never data loss.
 * - Identity travels with the repo via marker files (.git/blueberry-id,
 *   .lore/blueberry-id, .blueberry/id); the registry is the database.
 * - All writes are atomic.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJsonIfExists, samePath, slugify, ulid } from "./util.ts";
import {
	getCentralStoreDir,
	getInRepoStoreDir,
	getRegistryPath,
} from "./agent-dir.ts";

export type SessionStoreKind = "central" | "in-repo";

export interface Project {
	id: string; // ULID, immutable identity
	slug: string; // human handle, unique, used for store dir names
	canonicalPath: string; // current absolute path of the project root
	aliases: string[]; // every previous canonicalPath
	gitRemote: string | null; // origin URL when known (reattach key)
	sessionStore: SessionStoreKind;
	mergedInto: string | null; // nested-project merge: this project's sessions belong to another project
	trusted: boolean; // whether blueberry auto-writes pi trust entries
	createdAt: string;
	updatedAt: string;
}

export interface Registry {
	version: 1;
	projects: Project[];
}

export function emptyRegistry(): Registry {
	return { version: 1, projects: [] };
}

export function loadRegistry(agentDir: string): Registry {
	const data = readJsonIfExists<Registry>(getRegistryPath(agentDir));
	if (!data || !Array.isArray(data.projects)) return emptyRegistry();
	return {
		version: 1,
		projects: data.projects.filter((p) => p && typeof p.id === "string"),
	};
}

export async function saveRegistry(
	agentDir: string,
	registry: Registry,
): Promise<void> {
	mkdirSync(agentDir, { recursive: true });
	await atomicWriteJson(getRegistryPath(agentDir), registry);
}

export function newProject(init: {
	root: string;
	gitRemote?: string | null;
	id?: string;
	sessionStore?: SessionStoreKind;
}): Project {
	const now = new Date().toISOString();
	return {
		id: init.id ?? ulid(),
		slug: "", // assigned by caller via uniqueSlug
		canonicalPath: init.root,
		aliases: [],
		gitRemote: init.gitRemote ?? null,
		sessionStore: init.sessionStore ?? "central",
		mergedInto: null,
		trusted: true,
		createdAt: now,
		updatedAt: now,
	};
}

export function findById(registry: Registry, id: string): Project | undefined {
	return registry.projects.find((p) => p.id === id);
}

export function findBySlug(
	registry: Registry,
	slug: string,
): Project | undefined {
	return registry.projects.find((p) => p.slug === slug);
}

/** Match by current path or any historical alias. */
export function findByPath(
	registry: Registry,
	path: string,
): Project | undefined {
	// symlink-aware: /var/... and /private/var/... are the same project
	return registry.projects.find(
		(p) =>
			samePath(p.canonicalPath, path) || p.aliases.some((a) => samePath(a, path)),
	);
}

export function findByGitRemote(
	registry: Registry,
	remote: string,
): Project | undefined {
	return registry.projects.find(
		(p) => p.gitRemote === remote && p.gitRemote !== null,
	);
}

/** Produce a slug unique within the registry, suffixing -2, -3, ... */
export function uniqueSlug(registry: Registry, base: string): string {
	const root = slugify(base);
	let candidate = root;
	let n = 2;
	while (findBySlug(registry, candidate)) {
		candidate = `${root}-${n}`;
		n++;
	}
	return candidate;
}

export interface RegistryMutations {
	/** Register a new project; returns it added to the registry. */
	register(
		registry: Registry,
		init: { root: string; gitRemote?: string | null; id?: string },
	): Project;
	/** Update a project in place (sets updatedAt). */
	touch(registry: Registry, project: Project): void;
	/** Rename a project's slug; optionally move its central store directory. */
	renameSlug(
		agentDir: string,
		registry: Registry,
		oldSlug: string,
		newSlug: string,
	): Project;
	/** Point the canonical path at a new location (old path becomes an alias). */
	reattach(registry: Registry, project: Project, newPath: string): void;
	/** Merge project `from` into `into`: sessions move, identity absorbed. */
	merge(
		agentDir: string,
		registry: Registry,
		fromSlug: string,
		intoSlug: string,
	): { survivor: Project; moved: number };
	/** Remove from registry; optionally delete the central store. */
	forget(
		agentDir: string,
		registry: Registry,
		slug: string,
		opts: { purge: boolean },
	): { removed: Project; storeDir: string | null };
	/** Set/clear nested-session merge (child.mergedInto = parent.id), cycle-safe. */
	setNested(
		registry: Registry,
		childSlug: string,
		parentSlug: string | null,
	): Project;
	/** Switch session store mode and move files accordingly. */
	setStoreMode(
		agentDir: string,
		registry: Registry,
		slug: string,
		mode: SessionStoreKind,
	): Project;
}

export const mutations: RegistryMutations = {
	register(registry, init) {
		const project = newProject(init);
		project.slug = uniqueSlug(
			registry,
			init.root.split("/").filter(Boolean).pop() ?? "project",
		);
		registry.projects.push(project);
		return project;
	},

	touch(registry, project) {
		project.updatedAt = new Date().toISOString();
		const idx = registry.projects.findIndex((p) => p.id === project.id);
		if (idx >= 0) registry.projects[idx] = project;
		else registry.projects.push(project);
	},

	renameSlug(agentDir, registry, oldSlug, newSlug) {
		const project = findBySlug(registry, oldSlug);
		if (!project) throw new Error(`no project with slug '${oldSlug}'`);
		const clean = slugify(newSlug);
		if (clean !== newSlug)
			throw new Error(`slug '${newSlug}' is not slug-form (try '${clean}')`);
		const clash = findBySlug(registry, clean);
		if (clash && clash.id !== project.id)
			throw new Error(`slug '${clean}' already in use`);
		const oldDir = getCentralStoreDir(agentDir, oldSlug);
		if (project.sessionStore === "central" && existsSync(oldDir)) {
			const newDir = getCentralStoreDir(agentDir, clean);
			mkdirSync(newDir.split("/").slice(0, -1).join("/"), { recursive: true });
			renameSync(oldDir, newDir);
		}
		project.slug = clean;
		this.touch(registry, project);
		return project;
	},

	reattach(registry, project, newPath) {
		if (
			project.canonicalPath !== newPath &&
			!project.aliases.includes(project.canonicalPath)
		) {
			project.aliases.push(project.canonicalPath);
		}
		project.canonicalPath = newPath;
		this.touch(registry, project);
	},

	merge(agentDir, registry, fromSlug, intoSlug) {
		const from = findBySlug(registry, fromSlug);
		const into = findBySlug(registry, intoSlug);
		if (!from) throw new Error(`no project with slug '${fromSlug}'`);
		if (!into) throw new Error(`no project with slug '${intoSlug}'`);
		if (from.id === into.id)
			throw new Error("cannot merge a project into itself");
		if (from.mergedInto)
			throw new Error(
				`'${fromSlug}' is nested into another project; unnest first`,
			);

		// Move central store contents.
		let moved = 0;
		const fromDir = getCentralStoreDir(agentDir, from.slug);
		if (from.sessionStore === "central" && existsSync(fromDir)) {
			const intoDir = getCentralStoreDir(agentDir, into.slug);
			mkdirSync(intoDir, { recursive: true });
			for (const f of readdirSync(fromDir)) {
				renameSync(join(fromDir, f), join(intoDir, f));
				moved++;
			}
			rmSync(fromDir, { recursive: true, force: true });
		}

		// Repoint children that merged into `from`.
		for (const p of registry.projects) {
			if (p.mergedInto === from.id) p.mergedInto = into.id;
		}

		// Absorb identity: aliases and remote fold into the survivor.
		for (const alias of [from.canonicalPath, ...from.aliases]) {
			if (alias !== into.canonicalPath && !into.aliases.includes(alias))
				into.aliases.push(alias);
		}
		if (!into.gitRemote && from.gitRemote) into.gitRemote = from.gitRemote;

		registry.projects = registry.projects.filter((p) => p.id !== from.id);
		this.touch(registry, into);
		return { survivor: into, moved };
	},

	forget(agentDir, registry, slug, opts) {
		const project = findBySlug(registry, slug);
		if (!project) throw new Error(`no project with slug '${slug}'`);
		if (registry.projects.some((p) => p.mergedInto === project.id)) {
			throw new Error(`'${slug}' has nested projects; unnest them first`);
		}
		let storeDir: string | null = null;
		const dir = getCentralStoreDir(agentDir, slug);
		if (project.sessionStore === "central" && existsSync(dir)) {
			storeDir = dir;
			if (opts.purge) {
				rmSync(dir, { recursive: true, force: true });
				storeDir = null;
			}
		}
		registry.projects = registry.projects.filter((p) => p.id !== project.id);
		return { removed: project, storeDir };
	},

	setNested(registry, childSlug, parentSlug) {
		const child = findBySlug(registry, childSlug);
		if (!child) throw new Error(`no project with slug '${childSlug}'`);
		if (parentSlug === null) {
			child.mergedInto = null;
			this.touch(registry, child);
			return child;
		}
		const parent = findBySlug(registry, parentSlug);
		if (!parent) throw new Error(`no project with slug '${parentSlug}'`);
		if (parent.id === child.id)
			throw new Error("cannot nest a project into itself");
		// Cycle check: walk parent chain; reaching child means a cycle.
		let cursor: Project | undefined = parent;
		let depth = 0;
		while (cursor && cursor.mergedInto) {
			if (cursor.mergedInto === child.id)
				throw new Error("nesting would create a cycle");
			cursor = findById(registry, cursor.mergedInto);
			if (++depth > 16) throw new Error("nesting chain too deep (cycle?)");
		}
		child.mergedInto = parent.id;
		this.touch(registry, child);
		return child;
	},

	setStoreMode(agentDir, registry, slug, mode) {
		const project = findBySlug(registry, slug);
		if (!project) throw new Error(`no project with slug '${slug}'`);
		if (project.sessionStore === mode) return project;

		// Migrate session files between central and in-repo stores.
		const fromDir =
			project.sessionStore === "central"
				? getCentralStoreDir(agentDir, project.slug)
				: getInRepoStoreDir(project.canonicalPath);
		const toDir =
			mode === "central"
				? getCentralStoreDir(agentDir, project.slug)
				: getInRepoStoreDir(project.canonicalPath);
		if (existsSync(fromDir)) {
			mkdirSync(toDir, { recursive: true });
			for (const f of readdirSync(fromDir)) {
				renameSync(join(fromDir, f), join(toDir, f));
			}
			rmSync(fromDir, { recursive: true, force: true });
		}

		project.sessionStore = mode;
		this.touch(registry, project);
		return project;
	},
};
