import { expect, test, type Page } from "@playwright/test";

// All writes are intercepted. Regression coverage must never change a developer's settings.
async function mockSettings(
  page: Page,
  options: {
    restricted?: boolean;
    theme?: "light" | "dark";
  } = {},
) {
  const profile = (id: string, model: string) => ({
    id,
    name: id === "legacy" ? "My existing provider" : "Other provider",
    binding: "openai",
    base_url: "https://example.invalid/v1",
    api_key: "***",
    api_version: "2025-01-01",
    extra_headers: { "X-Custom-Header": "preserve-me" },
    api_format: "openai_chat",
    models: [
      {
        id: `${id}-model`,
        name: model,
        model,
        context_window: "128000",
        temperature: "0.37",
        custom_future_field: "keep-model-field",
      },
    ],
    custom_future_field: "keep-profile-field",
  });
  let catalog = {
    version: 1,
    connections: [
      {
        id: "saved-connection",
        name: "Existing connection",
        provider: "openai",
        api_key: "***",
        base_url: "https://example.invalid/v1",
        api_version: "",
      },
    ],
    services: Object.fromEntries(
      [
        "llm",
        "task",
        "embedding",
        "search",
        "tts",
        "stt",
        "imagegen",
        "videogen",
      ].map((service) => [
        service,
        service === "llm"
          ? {
              active_profile_id: "legacy",
              active_model_id: "legacy-model",
              profiles: [
                profile("other", "other-model"),
                profile("legacy", "existing-model"),
              ],
            }
          : { active_profile_id: null, active_model_id: null, profiles: [] },
      ]),
    ),
    custom_future_field: { preserved: true },
  };
  const original = structuredClone(catalog);
  let parked: any = null;
  let failWrites = false;
  const writes: { path: string; body: any }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON();
    const write =
      ["PUT", "POST", "DELETE", "PATCH"].includes(method) &&
      ![
        "/api/settings/model-capabilities",
        "/api/settings/test-provider",
      ].includes(path);
    if (write) {
      writes.push({ path, body });
      if (failWrites)
        return route.fulfill({
          status: 500,
          json: { detail: "Simulated save failure" },
        });
    }
    let json: any;
    if (path === "/api/auth/status")
      json = {
        enabled: !!options.restricted,
        authenticated: true,
        is_admin: !options.restricted,
        preset: options.restricted ? "learner" : null,
      };
    else if (path === "/api/settings" || path === "/api/settings/ui")
      json = {
        ui: {
          theme: options.theme ?? "light",
          code_block_theme: "github",
          code_block_show_line_numbers: true,
          code_block_wrap_long_lines: true,
        },
        ...(options.restricted ? {} : { catalog }),
        providers: {
          llm: [
            {
              value: "openai",
              label: "OpenAI",
              base_url: "https://api.openai.com/v1",
              api_formats: ["auto", "openai_chat"],
              default_api_format: "auto",
            },
          ],
        },
        connection_targets: [],
      };
    else if (path === "/api/settings/draft") {
      if (method === "PUT")
        parked = { ...body, version: 1, updated_at: "2026-09-16" };
      if (method === "DELETE") parked = null;
      json = { draft: parked };
    } else if (path === "/api/settings/apply") {
      catalog = structuredClone(parked.catalog);
      parked = null;
      json = { catalog };
    } else if (path === "/api/settings/chat-starters")
      json = {
        settings: { trace_count: 5 },
        bounds: { trace_count: { min: 1, max: 50 } },
      };
    else if (path === "/api/settings/readiness")
      json = {
        schema_version: "eas.settings-readiness/v2",
        ok: true,
        summary: {},
        rows: [],
        notices: [],
      };
    else if (path.includes("llm/options")) json = { options: [] };
    else return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ status: 200, json });
  });
  return {
    writes,
    original,
    catalog: () => catalog,
    draft: () => parked,
    fail: (value: boolean) => {
      failWrites = value;
    },
  };
}

const nav = (page: Page) =>
  page.getByRole("navigation", { name: "Settings sections", exact: true });

test.describe("Independent settings", () => {
  test("loads existing configuration without writes, separates pages, and keeps edits across navigation", async ({
    page,
  }) => {
    const state = await mockSettings(page);
    await page.goto("/settings#llm", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/settings\/llm(?:\?|$)/);
    await page.getByRole("button", { name: /existing-model/ }).click();
    await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue(
      "existing-model",
    );
    // Credentials now live on Providers; loading models must not expose them.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator("[data-settings-page]")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Apply changes", exact: true }),
    ).toHaveCount(0);
    expect(state.writes).toEqual([]);
    await page.getByLabel("Model ID", { exact: true }).fill("updated-model");
    await nav(page)
      .getByRole("link", { name: "Appearance", exact: true })
      .click();
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await expect(page.getByLabel("Model ID", { exact: true })).toHaveCount(0);
    await nav(page)
      .getByRole("link", { name: "Language models", exact: true })
      .click();
    await page.getByRole("button", { name: /updated-model/ }).click();
    await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue(
      "updated-model",
    );
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(
      page.getByText("Draft not applied yet", { exact: true }),
    ).toBeVisible();
    expect(state.catalog()).toEqual(state.original);
    const expected = structuredClone(state.original);
    expected.services.llm.profiles[1].models[0].model = "updated-model";
    expected.services.llm.profiles[1].models[0].name = "updated-model";
    expect(state.draft().catalog).toEqual(expected);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /updated-model/ }).click();
    await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue(
      "updated-model",
    );
    await page
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Apply changes", exact: true }),
    ).toHaveCount(0);
    expect(state.catalog()).toEqual(expected);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /updated-model/ }).click();
    await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue(
      "updated-model",
    );
    await page.screenshot({ path: "test-results/settings-models-desktop.png" });
  });

  test("preserves profile deep links and editing an inactive provider does not activate it", async ({
    page,
  }) => {
    const state = await mockSettings(page);
    await page.goto("/settings#llm?profile=other", { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue(
      "other-model",
    );
    await page
      .getByLabel("Model ID", { exact: true })
      .fill("edited-inactive-model");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(
      page.getByText("Draft not applied yet", { exact: true }),
    ).toBeVisible();
    expect(state.draft().catalog.services.llm.active_profile_id).toBe("legacy");
    expect(state.draft().catalog.services.llm.active_model_id).toBe(
      "legacy-model",
    );
    expect(state.draft().catalog.services.llm.profiles[1]).toEqual(
      state.original.services.llm.profiles[1],
    );
  });

  test("failed saves retain changes and returning offers to save a draft", async ({
    page,
  }) => {
    const state = await mockSettings(page);
    await page.goto("/settings/llm?profile=legacy", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Model ID", { exact: true }).fill("do-not-lose-me");
    state.fail(true);
    await page
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect(page.getByText(/Could not apply:/)).toBeVisible();
    expect(state.catalog()).toEqual(state.original);
    await page
      .getByRole("button", { name: "Back to app", exact: true })
      .click();
    await page.getByRole("button", { name: "Save draft and return" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(
      /Could not save the draft:/,
    );
    await expect(page).toHaveURL(/\/settings\/llm(?:\?|$)/);
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue(
      "do-not-lose-me",
    );
    state.fail(false);
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue(
      "existing-model",
    );
  });

  test("provider settings remain discoverable and removed categories are absent", async ({
    page,
  }) => {
    await mockSettings(page);
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Appearance", exact: true }),
    ).toBeVisible();
    await nav(page)
      .getByRole("textbox", { name: "Search settings" })
      .fill("provider");
    await nav(page)
      .getByRole("link", { name: "Providers", exact: true })
      .click();
    await expect(page).toHaveURL(/\/settings\/providers$/);
    await expect(page.locator("[data-settings-page]")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: "Embeddings", exact: true })).toBeVisible();
  });

  test("mobile English settings do not overflow", async ({
    page,
  }) => {
    await mockSettings(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/appearance", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Appearance", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/settings-appearance-mobile.png" });
    await page.getByRole("button", { name: "Settings sections" }).click();
    await page
      .getByRole("dialog")
      .getByRole("link", { name: "Providers", exact: true })
      .click();
    await expect(page).toHaveURL(/\/settings\/providers$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("tab", { name: "Language", exact: true }).click();
    await page.getByRole("button", { name: /existing-model/ }).click();
    await expect(page.getByLabel("Model ID", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: "test-results/settings-providers-mobile.png" });
  });

  test("restricted users cannot mount protected sections via direct URLs or search", async ({
    page,
  }) => {
    const state = await mockSettings(page, { restricted: true });
    const protectedRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/settings/chat-attachments"))
        protectedRequests.push(request.url());
    });
    await page.goto("/settings/attachments", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "This settings page is unavailable." }),
    ).toBeVisible();
    expect(protectedRequests).toEqual([]);
    await nav(page)
      .getByRole("textbox", { name: "Search settings" })
      .fill("attachments");
    await expect(
      nav(page).getByRole("link", { name: "Attachments" }),
    ).toHaveCount(0);
    expect(state.writes).toEqual([]);
  });

  test("desktop appearance layout has one sidebar and no catalog writes", async ({
    page,
  }) => {
    const state = await mockSettings(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/settings/appearance", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Appearance", exact: true }),
    ).toBeVisible();
    await expect(page.locator("aside")).toHaveCount(1);
    await page.screenshot({
      path: "test-results/settings-appearance-desktop.png",
    });
    expect(state.writes).toEqual([]);
  });
});

test("diagnostics target the provider being edited without changing the active choice", async ({
  page,
}) => {
  const state = await mockSettings(page);
  let diagnosticCatalog: any;
  await page.route("**/api/settings/tests/llm/start*", async (route) => {
    diagnosticCatalog = route.request().postDataJSON().catalog;
    // No real provider call: capture just the request contract.
    await route.fulfill({
      status: 400,
      json: { detail: "Test transport intentionally disabled" },
    });
  });
  await page.goto("/settings/llm?profile=other", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue(
    "other-model",
  );
  await page.getByRole("button", { name: "Test model", exact: true }).click();
  await expect
    .poll(() => diagnosticCatalog?.services.llm.active_profile_id)
    .toBe("other");
  expect(diagnosticCatalog.services.llm.active_model_id).toBe("other-model");
  expect(state.catalog()).toEqual(state.original);
  await expect(
    page.getByRole("button", { name: "Apply changes", exact: true }),
  ).toHaveCount(0);
});

test("provider discovery stays staged and model choices preserve existing models", async ({ page }) => {
  const state = await mockSettings(page);
  const probes: any[] = [];
  await page.route("**/api/settings/test-provider*", async route => {
    probes.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: "connected", models: [{ id: "new-provider-model" }, { id: "existing-model" }] } });
  });
  await page.goto("/settings/connections?provider=llm:legacy", { waitUntil: "domcontentloaded" });
  await page.getByLabel("API key", { exact: true }).fill("new-unsaved-key");
  await page.getByRole("button", { name: "Test provider", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Provider connected" })).toBeVisible();
  expect(probes[0]).toMatchObject({ api_key: "new-unsaved-key", profile_id: "legacy", service: "llm", extra_headers: { "X-Custom-Header": "preserve-me" } });
  expect(probes[0]).not.toHaveProperty("model");
  expect(state.writes).toEqual([]);
  await nav(page).getByRole("link", { name: "Language models", exact: true }).click();
  await page.getByRole("button", { name: /existing-model/ }).click();
  const model = page.getByLabel("Model ID", { exact: true });
  await expect(model).toHaveValue("existing-model");
  await model.fill("new-provider");
  await page.getByRole("option", { name: "new-provider-model", exact: true }).click();
  await expect(model).toHaveValue("new-provider-model");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft not applied yet", { exact: true })).toBeVisible();
  const updated = state.draft().catalog.services.llm;
  expect(updated.active_profile_id).toBe("legacy");
  expect(updated.active_model_id).toBe("legacy-model");
  expect(updated.profiles[1].models).toHaveLength(1);
  expect(updated.profiles[1].models[0]).toEqual({ ...state.original.services.llm.profiles[1].models[0], model: "new-provider-model", name: "new-provider-model" });
  expect(updated.profiles[0]).toEqual(state.original.services.llm.profiles[0]);
  expect(state.catalog()).toEqual(state.original);
});

test("provider errors and unsupported discovery keep manual entry available", async ({ page }) => {
  await mockSettings(page);
  let status = "auth_error";
  await page.route("**/api/settings/test-provider*", route => route.fulfill({ json: { status, models: [] } }));
  await page.goto("/settings/llm?profile=legacy", { waitUntil: "domcontentloaded" });
  const probe = page.getByRole("button", { name: "Get model list", exact: true });
  await probe.click();
  await expect(page.getByRole("status").filter({ hasText: "The provider rejected these credentials." })).toBeVisible();
  status = "unavailable";
  await probe.click();
  await expect(page.getByRole("status").filter({ hasText: "This provider does not expose a model list." })).toBeVisible();
  await page.getByLabel("Model ID", { exact: true }).fill("manual-custom-id");
  await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue("manual-custom-id");
  status = "connected";
  await probe.click();
  await expect(page.getByRole("status").filter({ hasText: "0 models available" })).toBeVisible();
  await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue("manual-custom-id");
});

test("a delayed probe cannot attach results to changed credentials or another provider", async ({ page }) => {
  const state = await mockSettings(page);
  let finish: (() => void) | undefined;
  await page.route("**/api/settings/test-provider*", async route => {
    await new Promise<void>(resolve => { finish = resolve; });
    await route.fulfill({ json: { status: "connected", models: [{ id: "stale-model" }] } }).catch(() => {});
  });
  await page.goto("/settings/connections?provider=llm:legacy", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Test provider", exact: true }).click();
  await expect.poll(() => Boolean(finish)).toBe(true);
  await page.getByLabel("API key", { exact: true }).fill("changed-key");
  await page.getByRole("button", { name: /Other provider.*models/ }).click();
  await expect(page.getByRole("heading", { name: "Other provider", exact: true })).toBeVisible();
  finish!();
  await expect(page.getByRole("button", { name: "Test provider", exact: true })).toBeEnabled();
  await expect(page.getByText(/Provider connected/)).toHaveCount(0);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft not applied yet", { exact: true })).toBeVisible();
  expect(state.draft().catalog.services.llm.profiles.every((profile: any) => !profile.discovery)).toBe(true);
});

test("dark tablet settings keep provider hierarchy and keyboard access", async ({ page }) => {
  await mockSettings(page, { theme: "dark" });
  await page.addInitScript(() => localStorage.setItem("eas-theme", "dark"));
  await page.setViewportSize({ width: 900, height: 1100 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/settings/connections", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const provider = page.getByRole("button", { name: /My existing provider/ });
  await expect(provider).toHaveAttribute("aria-pressed", "false");
  await provider.focus();
  await page.keyboard.press("Enter");
  await expect(provider).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "My existing provider", exact: true })).toBeVisible();
  const other = page.getByRole("button", { name: /Other provider/ });
  await other.focus();
  await page.keyboard.press("Enter");
  await expect(other).toHaveAttribute("aria-pressed", "true");
  await expect(provider).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("a new provider can be tested with only a key and supplies discovered model choices", async ({ page }) => {
  const state = await mockSettings(page);
  const probes: any[] = [];
  await page.route("**/api/settings/test-provider*", route => {
    probes.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: "connected", models: [{ id: "chosen-model" }] } });
  });
  await page.goto("/settings/connections", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByLabel("Provider type", { exact: true }).selectOption("openai");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Provider URL", { exact: true })).toHaveValue("");
  await page.getByLabel("API key", { exact: true }).fill("new-key");
  await page.getByRole("button", { name: "Test provider", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Provider connected" })).toBeVisible();
  expect(probes[0]).toMatchObject({ api_key: "new-key", base_url: "https://api.openai.com/v1" });
  await page.getByRole("region", { name: "Provider settings" }).getByRole("link", { name: "Language models", exact: true }).click();
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const model = page.getByLabel("Model ID", { exact: true });
  await model.fill("chosen");
  await page.getByRole("option", { name: "chosen-model", exact: true }).click();
  await expect(model).toHaveValue("chosen-model");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft not applied yet", { exact: true })).toBeVisible();
  const llm = state.draft().catalog.services.llm;
  expect(llm.active_profile_id).toBe("legacy");
  expect(llm.active_model_id).toBe("legacy-model");
  expect(llm.profiles.slice(0, 2)).toEqual(state.original.services.llm.profiles);
  expect(llm.profiles[2].models).toHaveLength(1);
  expect(llm.profiles[2].models[0].model).toBe("chosen-model");
});
