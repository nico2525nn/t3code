import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
  parseRemoteHostForSourceControl,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";

describe("source control presentation", () => {
  it("uses merge request terminology for GitLab", () => {
    assert.deepEqual(getChangeRequestTerminologyForKind("gitlab"), {
      shortLabel: "MR",
      singular: "merge request",
    });
  });

  it("uses pull request terminology for GitHub-compatible providers", () => {
    assert.deepEqual(getChangeRequestTerminologyForKind("github"), {
      shortLabel: "PR",
      singular: "pull request",
    });
    assert.deepEqual(getChangeRequestTerminologyForKind("azure-devops"), {
      shortLabel: "PR",
      singular: "pull request",
    });
    assert.deepEqual(getChangeRequestTerminologyForKind("bitbucket"), {
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("falls back to generic change request copy for unknown providers", () => {
    const presentation = resolveChangeRequestPresentation({
      kind: "unknown",
      name: "forge",
      baseUrl: "",
    });

    assert.equal(presentation.shortName, "change request");
    assert.equal(presentation.longName, "change request");
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("detects common source control hosts", () => {
    assert.equal(
      detectSourceControlProviderFromRemoteUrl("git@github.com:owner/repo.git")?.kind,
      "github",
    );
    assert.equal(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com/group/repo.git")?.kind,
      "gitlab",
    );
    assert.equal(
      detectSourceControlProviderFromRemoteUrl("https://dev.azure.com/org/project/_git/repo")?.kind,
      "azure-devops",
    );
    assert.equal(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
      "bitbucket",
    );
  });
});

describe("parseRemoteHostOption", () => {
  it("returns parsed hosts as options", () => {
    assert.deepEqual(
      parseRemoteHostForSourceControl("git@github.com:owner/repo.git"),
      Option.some("github.com"),
    );
    assert.deepEqual(
      parseRemoteHostForSourceControl("https://gitlab.com/group/repo.git"),
      Option.some("gitlab.com"),
    );
  });

  it("returns none for empty or invalid remotes", () => {
    assert.equal(Option.isNone(parseRemoteHostForSourceControl("   ")), true);
    assert.equal(Option.isNone(parseRemoteHostForSourceControl("not a url")), true);
  });
});
