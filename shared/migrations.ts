import { z } from "zod";
import {
  dataSchema,
  DEFAULT_LABELS,
  groupSchema,
  labelKey,
  orderedGroups,
  settingsSchema,
  taskSchema,
} from "./model";

const legacyStages = [
  "todo",
  "in-progress",
  "review",
  "done",
  "canceled",
] as const;
const legacyGroups = legacyStages.map((kind) => ({
  id: kind,
  kind,
  name: null,
  label: DEFAULT_LABELS[kind],
}));
const priorSettings = settingsSchema
  .omit({ pinInProgressWorkspaces: true })
  .extend({
    pinRunningWorkspaces: z.boolean().default(true),
  });
const legacySettings = priorSettings.omit({ groups: true }).extend({
  labels: z
    .object({
      todo: z.string().trim().min(1),
      "in-progress": z.string().trim().min(1),
      review: z.string().trim().min(1),
      done: z.string().trim().min(1),
      canceled: z.string().trim().min(1),
    })
    .prefault(DEFAULT_LABELS)
    .refine(
      (labels) =>
        new Set(Object.values(labels).map(labelKey)).size ===
        legacyStages.length,
    ),
});
/**
 * Before v6 a task kept one conversation status plus a string list of agent ids. Stored
 * data from those versions is parsed with this shape and upgraded by `migrateV5`.
 */
const preV6Task = taskSchema
  .omit({
    conversationDisplayEvidence: true,
    conversationGateAt: true,
    conversationGateEvidence: true,
    conversationReason: true,
  })
  .extend({ conversationAgents: z.array(z.string()).default([]) });
const preV6Tasks = z.array(preV6Task).default([]);
const legacyData = z.object({
  ...dataSchema.shape,
  schemaVersion: z.literal(1).default(1),
  settings: legacySettings.default(() => legacySettings.parse({})),
  tasks: z
    .array(
      preV6Task.extend({
        draftStage: z.enum(["todo", "canceled"]),
        lastStage: z.enum([...legacyStages, "conflict"]),
        archived: taskSchema.shape.archived
          .unwrap()
          .omit({ group: true })
          .nullable(),
        binding: taskSchema.shape.binding
          .unwrap()
          .omit({ stage: true })
          .nullable(),
      }),
    )
    .default([]),
});
const v2Settings = priorSettings.extend({
  groups: z.array(groupSchema).min(1).default(legacyGroups),
});
const v2Data = z.object({
  ...dataSchema.shape,
  schemaVersion: z.literal(2).default(2),
  tasks: preV6Tasks,
  settings: v2Settings.default(() => v2Settings.parse({})),
});
const v3Data = v2Data.extend({
  schemaVersion: z.literal(3).default(3),
  settings: priorSettings.default(() => priorSettings.parse({})),
});

/**
 * v6 splits the conversation record into display evidence and gate evidence. A once exact
 * observation stays a valid lower bound when the task later became unknown, and never a
 * gate: the real last message may be newer than what was last observed.
 */
function migrateV5(values: unknown) {
  const previous = z
    .object({
      ...dataSchema.shape,
      schemaVersion: z.literal(5).default(5),
      tasks: preV6Tasks,
    })
    .parse(values);
  return dataSchema.parse({
    ...previous,
    schemaVersion: 6,
    tasks: previous.tasks.map((task) => {
      const observedAt = task.lastConversationAt;
      const display =
        task.conversationStatus === "known"
          ? observedAt
            ? "exact"
            : "none"
          : task.conversationStatus === "none"
            ? "none"
            : observedAt
              ? "lower-bound"
              : "unknown";
      const gate =
        task.conversationStatus === "known" && observedAt ? observedAt : null;
      return {
        ...task,
        conversationDisplayEvidence: display,
        conversationGateAt: gate,
        conversationGateEvidence: gate ? "exact" : "unknown",
        conversationReason: null,
        conversationAgents: task.conversationAgents.map((id) => ({
          id,
          lastObservedAt: null,
          seenWhileLive: true,
        })),
      };
    }),
  });
}

function migrateV1(values: unknown) {
  const previous = legacyData.parse(values);
  const { labels, ...preferences } = previous.settings;
  const groups = legacyStages.map((kind) => ({
    id: kind,
    kind,
    name: null,
    label: labels[kind],
  }));
  return {
    ...previous,
    schemaVersion: 2,
    settings: { ...preferences, groups },
    tasks: previous.tasks.map((task) => ({
      ...task,
      binding: task.binding ? { ...task.binding, stage: "in-progress" } : null,
      archived: task.archived
        ? {
            ...task.archived,
            group:
              groups.find((group) => group.id === task.archived!.stage) ?? null,
          }
        : null,
    })),
  };
}

function addInbox(values: unknown, fromVersion: number) {
  const previous = v2Data.parse(fromVersion === 1 ? migrateV1(values) : values);
  const groups = previous.settings.groups;
  let id = "inbox";
  for (let suffix = 2; groups.some((group) => group.id === id); suffix++)
    id = `inbox-${suffix}`;
  let label = DEFAULT_LABELS.inbox;
  for (
    let suffix = 2;
    groups.some((group) => labelKey(group.label) === labelKey(label));
    suffix++
  )
    label = `${DEFAULT_LABELS.inbox}-${suffix}`;
  return {
    ...previous,
    schemaVersion: 3,
    settings: {
      ...previous.settings,
      groups: [{ id, kind: "inbox", name: null, label }, ...groups],
      groupOrder: previous.settings.groupOrder.length
        ? [id, ...orderedGroups(previous.settings).map((group) => group.id)]
        : [],
    },
  };
}

/** Paseo persists the validated migration once, retaining its revision check. */
export function migrateData(values: unknown, fromVersion: number) {
  if (fromVersion === 5) return migrateV5(values);
  if (fromVersion === 4) {
    const previous = z
      .object({
        ...dataSchema.shape,
        schemaVersion: z.literal(4),
        tasks: preV6Tasks,
      })
      .parse(values);
    return migrateV5({ ...previous, schemaVersion: 5 });
  }
  if (![1, 2, 3].includes(fromVersion))
    throw new Error("Unsupported Workboard storage version");
  const previous = v3Data.parse(
    fromVersion === 3 ? values : addInbox(values, fromVersion),
  );
  const { pinRunningWorkspaces, ...settings } = previous.settings;
  return migrateV5({
    ...previous,
    schemaVersion: 5,
    settings: { ...settings, pinInProgressWorkspaces: pinRunningWorkspaces },
    autoPins: {},
  });
}
