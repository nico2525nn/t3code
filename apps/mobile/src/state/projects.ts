import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import { selectProjectFaviconSources } from "@t3tools/client-runtime/state/project-favicon";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

/** One favicon source per repository group, keyed by physical project key. */
export const projectFaviconSourcesAtom = Atom.make((get) =>
  selectProjectFaviconSources(get(environmentProjects.projectsAtom), null),
).pipe(Atom.withLabel("mobile-project-favicon-sources"));
