import { randomUUID } from "node:crypto";

function chatContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: any[] = content.flatMap((part: any): any[] => {
    if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
      return [{ type: "text", text: String(part.text || "") }];
    }
    if (part?.type === "input_image" && typeof part.image_url === "string") {
      return [{ type: "image_url", image_url: { url: part.image_url, detail: part.detail || "auto" } }];
    }
    return [];
  });
  return parts.every((part: any) => part.type === "text") ? parts.map((part: any) => part.text).join("\n") : parts;
}

export function toChatRequest(request: Record<string, any>): Record<string, any> {
  const messages: any[] = [];
  if (typeof request.instructions === "string" && request.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }
  const input = typeof request.input === "string" ? [{ role: "user", content: request.input }] : request.input;
  if (!Array.isArray(input)) throw new Error("This endpoint requires text or message input.");
  for (const item of input) {
    if (item?.type === "reasoning") continue;
    if (item?.type === "function_call") {
      const call = { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } };
      const previous = messages.at(-1);
      if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) previous.tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (item?.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
    } else if (item?.role && ["user", "assistant", "system", "developer"].includes(item.role)) {
      messages.push({ role: item.role === "developer" ? "system" : item.role, content: chatContent(item.content) });
    } else {
      throw new Error(`This endpoint cannot translate a ${String(item?.type || "unknown")} input item.`);
    }
  }
  const tools = Array.isArray(request.tools) ? request.tools.filter((tool: any) => tool?.type === "function").map((tool: any) => ({
    type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  })) : [];
  return {
    model: request.model,
    messages,
    ...(tools.length ? { tools, tool_choice: request.tool_choice || "auto" } : {}),
    ...(typeof request.max_output_tokens === "number" ? { max_tokens: request.max_output_tokens } : {}),
    stream: false,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text || "")).join("");
  return "";
}

export function chatToResponse(request: Record<string, any>, completion: Record<string, any>): Record<string, any> {
  const message = completion.choices?.[0]?.message;
  if (!message || typeof message !== "object") throw new Error("Chat Completions endpoint returned no assistant message.");
  const output: any[] = [];
  const text = textOf(message.content);
  if (text) output.push({ id: `msg_${randomUUID().replace(/-/g, "")}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
  for (const call of message.tool_calls || []) {
    if (call?.type !== "function" || typeof call.function?.name !== "string") continue;
    output.push({ id: `fc_${randomUUID().replace(/-/g, "")}`, type: "function_call", status: "completed", call_id: call.id || `call_${randomUUID().replace(/-/g, "")}`, name: call.function.name, arguments: call.function.arguments || "{}" });
  }
  if (!output.length) throw new Error("Chat Completions endpoint returned no text or function calls.");
  const usage = completion.usage;
  return {
    id: `resp_${randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: completion.model || request.model,
    output,
    usage: usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number" ? {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
      output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 },
    } : null,
  };
}

export function responseEvents(response: Record<string, any>): string {
  let sequence_number = 0;
  const events: string[] = [];
  const emit = (type: string, data: Record<string, any>) => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...data })}\n\n`);
  };
  emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
  response.output.forEach((item: any, output_index: number) => {
    emit("response.output_item.added", { output_index, item: { ...item, status: "in_progress", ...(item.type === "message" ? { content: [] } : { arguments: "" }) } });
    if (item.type === "message") {
      const text = item.content[0].text;
      const position = { item_id: item.id, output_index, content_index: 0 };
      emit("response.content_part.added", { ...position, part: { type: "output_text", text: "", annotations: [] } });
      emit("response.output_text.delta", { ...position, delta: text });
      emit("response.output_text.done", { ...position, text });
      emit("response.content_part.done", { ...position, part: item.content[0] });
    } else if (item.type === "function_call") {
      emit("response.function_call_arguments.delta", { item_id: item.id, output_index, delta: item.arguments });
      emit("response.function_call_arguments.done", { item_id: item.id, output_index, arguments: item.arguments });
    }
    emit("response.output_item.done", { output_index, item });
  });
  emit("response.completed", { response });
  return events.join("");
}
