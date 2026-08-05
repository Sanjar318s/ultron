/**
 * n8n webhook-action registry (LOCALHOST-only, server-side).
 *
 * n8n acts as an external executor for cloud processes (Google Sheets, email,
 * Notion, Telegram, …). Ultron's LLM picks a scenario, fills the payload per
 * its schema, and the route fires the webhook. The n8n workflow routes on the
 * `scenario` field via a Switch node. Local PC control (launcher.ts) never
 * goes through n8n — it stays on the fast local reflex layer.
 *
 * All actions share the single N8N_WEBHOOK_URL; the body adds `scenario` so
 * the workflow knows which branch to run. No `@/` imports here — self-test
 * imports this file directly from Node.
 */

export interface N8nWebhookAction {
  id: string;
  name: string;
  description: string;
  webhookUrl: string;
  /** Field → human description, used to teach the LLM what payload to build. */
  payloadSchema: Record<string, string>;
}

const ACTIONS: N8nWebhookAction[] = [
  {
    id: "n8n-google-sheets-sync",
    name: "Запись в Google Таблицу",
    description: "Записывает новую строку с данными в рабочую табличку",
    webhookUrl: process.env.N8N_WEBHOOK_URL || "",
    payloadSchema: {
      title: "Заголовок/тема (строка)",
      amount: "Сумма или значение (число/строка)",
      category: "Категория (строка)",
    },
  },
  {
    id: "n8n-send-summary-email",
    name: "Отправка Email-отчёта",
    description: "Формирует и отправляет сводный отчёт на указанный email",
    webhookUrl: process.env.N8N_WEBHOOK_URL || "",
    payloadSchema: {
      recipient: "Email получателя (строка)",
      subject: "Тема письма (строка)",
      content: "Текст отчёта (строка)",
    },
  },
];

export const N8N_ACTIONS = ACTIONS;

/** Actions whose webhook is actually configured (env var set). */
export function configuredN8nActions(): N8nWebhookAction[] {
  return ACTIONS.filter((a) => a.webhookUrl.trim() !== "");
}

/** System-prompt block listing configured n8n scenarios for the LLM. */
export function n8nActionsPrompt(): string {
  const configured = configuredN8nActions();
  if (configured.length === 0) return "";
  const lines = configured.map(
    (a) =>
      `- id: ${a.id} («${a.name}»): ${a.description}. Поля payload:\n` +
      Object.entries(a.payloadSchema)
        .map(([k, v]) => `    "${k}" — ${v}`)
        .join("\n"),
  );
  return [
    "",
    "N8N AUTOMATIONS (внешние сценарии через webhook): если запрос подходит под один из сценариев ниже — верни action {\"type\":\"n8n_trigger\",\"actionId\":\"<id>\",\"payload\":{...}}. Заполняй поля payload строго по схеме, значения — строками. Не выдумывай сценарии, которых нет в списке:",
    lines.join("\n"),
  ].join("\n");
}

/** Webhook body: `scenario` routes the n8n Switch node to the right branch. */
export function buildN8nPayload(actionId: string, payload?: Record<string, unknown>): Record<string, unknown> {
  return { scenario: actionId, ...(payload ?? {}) };
}
