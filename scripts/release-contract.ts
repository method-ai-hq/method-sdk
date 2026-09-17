export type ReleaseFile = {name:string; sha256:string};
export function assertImmutableArtifacts(current: ReleaseFile[], previous: ReleaseFile[]) {
  const old = new Map(previous.map(file => [file.name,file.sha256]));
  for (const file of current) {
    // Install entrypoints and runtime-to-SDK lookup files are mutable aliases.
    const immutable = /\.(tgz|whl)$/.test(file.name) || /^cli\/\d+\.\d+\.\d+-.*\.txt$/.test(file.name);
    if (immutable && old.has(file.name) && old.get(file.name) !== file.sha256) throw Error(`Released archive changed: ${file.name}. Use a new package version.`);
  }
}
