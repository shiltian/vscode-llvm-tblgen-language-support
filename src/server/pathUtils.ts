import { fileURLToPath, pathToFileURL } from "url";

export function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

export function uriToFilePath(uri: string): string {
  return fileURLToPath(uri);
}
