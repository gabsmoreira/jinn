import type { SseDataEvent } from "./sse-pty-proxy.js";

export interface QuestionOption { label: string; description?: string; }
export interface QuestionSpec {
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}
export interface QuestionBlockPayload {
  toolId: string;
  answered: boolean;
  questions: QuestionSpec[];
}

/** Normalize Claude's AskUserQuestion tool input into our question specs.
 *  Claude sends `{ questions: [{ header, question, multiSelect?, options: [{ label, description? }] }] }`.
 *  Returns null if the shape is unusable (no questions / no options). */
export function parseAskUserQuestionInput(input: unknown): QuestionSpec[] | null {
  if (!input || typeof input !== "object") return null;
  const rawQs = (input as Record<string, unknown>).questions;
  if (!Array.isArray(rawQs) || rawQs.length === 0) return null;
  const questions: QuestionSpec[] = [];
  for (const rq of rawQs) {
    if (!rq || typeof rq !== "object") continue;
    const q = rq as Record<string, unknown>;
    const rawOpts = Array.isArray(q.options) ? q.options : [];
    const options: QuestionOption[] = [];
    for (const ro of rawOpts) {
      if (ro && typeof ro === "object") {
        const o = ro as Record<string, unknown>;
        if (typeof o.label === "string") {
          const option: QuestionOption = { label: o.label };
          if (typeof o.description === "string") option.description = o.description;
          options.push(option);
        }
      } else if (typeof ro === "string") {
        options.push({ label: ro });
      }
    }
    if (options.length === 0) continue;
    questions.push({
      header: typeof q.header === "string" ? q.header : "",
      question: typeof q.question === "string" ? q.question : "",
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return questions.length > 0 ? questions : null;
}

/** Accumulates the AskUserQuestion tool_use block's input across SSE events for a
 *  single turn. Tracks the content-block index that belongs to an AskUserQuestion
 *  tool_use, concatenates its input_json_delta chunks, and on content_block_stop
 *  parses + returns the payload exactly once. Non-AskUserQuestion blocks are ignored. */
export class AskUserQuestionAssembler {
  private activeIndex: number | undefined;
  private toolId = "";
  private buf = "";

  reset(): void {
    this.activeIndex = undefined;
    this.toolId = "";
    this.buf = "";
  }

  onEvent(e: SseDataEvent): QuestionBlockPayload | null {
    const type = e.type;
    if (type === "content_block_start") {
      const cb = (e as any).content_block;
      if (cb?.type === "tool_use" && cb?.name === "AskUserQuestion") {
        this.activeIndex = (e as any).index;
        this.toolId = String(cb.id ?? "");
        this.buf = "";
      }
      return null;
    }
    if (this.activeIndex === undefined) return null;
    if (type === "content_block_delta" && (e as any).index === this.activeIndex) {
      const d = (e as any).delta;
      if (d?.type === "input_json_delta" && typeof d.partial_json === "string") this.buf += d.partial_json;
      return null;
    }
    if (type === "content_block_stop" && (e as any).index === this.activeIndex) {
      const toolId = this.toolId;
      const buf = this.buf;
      this.activeIndex = undefined;
      this.toolId = "";
      this.buf = "";
      let parsed: unknown;
      try { parsed = JSON.parse(buf); } catch { return null; }
      const questions = parseAskUserQuestionInput(parsed);
      if (!questions) return null;
      return { toolId, answered: false, questions };
    }
    return null;
  }
}
