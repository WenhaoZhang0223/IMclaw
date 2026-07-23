import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const WORKFILE_DIRECTORY_NAME = "workfile";

export async function resolveWorkfileRoot(
	workspace: string,
	realpathFn: (path: string) => Promise<string> = realpath,
): Promise<string> {
	return realpathFn(join(workspace, WORKFILE_DIRECTORY_NAME));
}

export function isPathInside(rootRealPath: string, targetRealPath: string): boolean {
	const childPath = relative(rootRealPath, targetRealPath);
	return childPath !== "" && childPath !== ".." && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath);
}
