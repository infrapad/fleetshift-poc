import { expect, test } from "@playwright/experimental-ct-react";

import type { InfrapadBlock } from "../api";
import BlockRevisionsPanel from "../BlockRevisionsPanel";

const HISTORY_URL = "**/v1/documents/*/blocks/*/history*";

function block(
  rev: number,
  content: Record<string, unknown>,
  extra?: Partial<InfrapadBlock>,
): InfrapadBlock {
  return {
    name: "documents/d/blocks/1",
    blockNumber: 1,
    revisionNumber: rev,
    type: "markdown",
    content,
    ...extra,
  };
}

function ok(blocks: InfrapadBlock[]) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ blocks }),
  };
}

test.describe("BlockRevisionsPanel", () => {
  test("shows spinner while loading", async ({ mount, page }) => {
    await page.route(HISTORY_URL, () => {});
    const c = await mount(<BlockRevisionsPanel docId="d" blockNumber={1} />);
    await expect(c.getByText("Loading revisions…")).toBeVisible();
  });

  test("shows error from API", async ({ mount, page }) => {
    await page.route(HISTORY_URL, (r) =>
      r.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "db down" }),
      }),
    );
    const c = await mount(<BlockRevisionsPanel docId="d" blockNumber={1} />);
    await expect(c.getByText("db down")).toBeVisible();
  });

  test("no history when single revision", async ({ mount, page }) => {
    await page.route(HISTORY_URL, (r) =>
      r.fulfill(ok([block(1, { text: "only one" })])),
    );
    const c = await mount(<BlockRevisionsPanel docId="d" blockNumber={1} />);
    await expect(c.getByText("No previous revisions.")).toBeVisible();
  });

  test("renders revisions: order, text, diffs, metadata, and API path", async ({
    mount,
    page,
  }) => {
    let capturedUrl = "";
    await page.route(HISTORY_URL, (r) => {
      capturedUrl = r.request().url();
      // Out-of-order to verify sorting
      return r.fulfill(
        ok([
          block(3, { text: "line one\nline THREE\nline three" }, {
            authorId: "carol",
          }),
          block(1, { text: "line one\nline two\nline three" }, {
            authorId: "alice",
            createdAt: "2026-08-17T13:38:49Z",
          }),
          block(2, { text: "line one\nline TWO\nline three" }, {
            authorId: "bob",
          }),
        ]),
      );
    });

    const c = await mount(
      <BlockRevisionsPanel docId="my-incident" blockNumber={3} />,
    );

    const entries = c.locator(".infrapad-revision-entry");
    await expect(entries).toHaveCount(3);

    // API path
    expect(capturedUrl).toContain("/v1/documents/my-incident/blocks/3/history");

    // Chronological order
    await expect(entries.nth(0)).toContainText("rev 1");
    await expect(entries.nth(1)).toContainText("rev 2");
    await expect(entries.nth(2)).toContainText("rev 3");

    // First revision: full text, not diff
    await expect(
      entries.nth(0).locator(".infrapad-revision-text-content"),
    ).toContainText("line two");

    // Second revision: diff with removed/added lines
    const diff = entries.nth(1).locator(".infrapad-revision-diff-content");
    await expect(diff.locator(".infrapad-diff-line--removed").first()).toContainText("line two");
    await expect(diff.locator(".infrapad-diff-line--added").first()).toContainText("line TWO");

    // Metadata
    await expect(entries.nth(0)).toContainText("alice");
    await expect(entries.nth(0)).toContainText("2026");
    await expect(entries.nth(1)).toContainText("bob");
  });

  test("alerts_matcher renders as YAML and diffs across revisions", async ({
    mount,
    page,
  }) => {
    await page.route(HISTORY_URL, (r) =>
      r.fulfill(
        ok([
          block(1, {
            LabelsMatchers: [{ endpoint: ["ep1"], name: ["AlertA"] }],
            Since: "2026-08-17T13:38:49Z",
          }, { type: "alerts_matcher" }),
          block(2, {
            LabelsMatchers: [{ endpoint: ["ep1", "ep2"], name: ["AlertA"] }],
            Since: "2026-08-17T13:38:49Z",
          }, { type: "alerts_matcher" }),
        ]),
      ),
    );

    const c = await mount(<BlockRevisionsPanel docId="d" blockNumber={1} />);

    // First: YAML with inline arrays
    const text = c.locator(".infrapad-revision-entry").nth(0)
      .locator(".infrapad-revision-text-content");
    await expect(text).toContainText("LabelsMatchers:");
    await expect(text).toContainText("[ep1]");

    // Second: diff shows added endpoint
    await expect(
      c.locator(".infrapad-revision-entry").nth(1)
        .locator(".infrapad-revision-diff-content"),
    ).toContainText("ep2");
  });
});
