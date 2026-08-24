/**
 * locale.tsx unit tests: device language resolution (language follows
 * navigator.language when no stored preference exists; language/theme
 * initialization does not depend on login state and also applies on the
 * login page).
 */
import { describe, expect, it } from "vitest";
import { en } from "../src/lib/strings-en";
import { zh } from "../src/lib/strings";
import { resolveSystemLocale } from "../src/state/locale";

describe("resolveSystemLocale (navigator.language → UI language)", () => {
  it("zh prefix (any case or region variant) → zh", () => {
    expect(resolveSystemLocale("zh-CN")).toBe("zh");
    expect(resolveSystemLocale("ZH-TW")).toBe("zh");
  });

  it("non-Chinese or unavailable → English fallback", () => {
    expect(resolveSystemLocale("en-US")).toBe("en");
    expect(resolveSystemLocale(undefined)).toBe("en");
  });
});

describe("logical Trace workspace copy", () => {
  it("keeps navigation and child Trace labels in both dictionaries", () => {
    expect(zh.traces.logicalTraceExplorer).toBe("逻辑 Trace 工作区");
    expect(zh.traces.logicalTraceSteps).toBe("Agent Steps");
    expect(zh.traces.logicalTraceRootUnavailable).toContain("Trace Root");
    expect(zh.traces.traceStepChildSession).toBe("子 Session");
    expect(zh.traces.traceStepOpenChildTrace).toBe("打开子 Agent Trace");
    expect(zh.traces.traceStepPlanning).toBe("规划");
    expect(zh.traces.traceStepVerification).toBe("验证");
    expect(zh.traces.traceStepEvaluation).toBe("评估");
    expect(en.traces.logicalTraceExplorer).toBe("Logical Trace workspace");
    expect(en.traces.logicalTraceSteps).toBe("Agent Steps");
    expect(en.traces.logicalTraceRootUnavailable).toContain("Trace root");
    expect(en.traces.traceStepChildSession).toBe("Child Session");
    expect(en.traces.traceStepOpenChildTrace).toBe("Open child agent Trace");
    expect(en.traces.traceStepPlanning).toBe("Planning");
    expect(en.traces.traceStepVerification).toBe("Verification");
    expect(en.traces.traceStepEvaluation).toBe("Evaluation");
  });
});
