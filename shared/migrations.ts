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
const legacyData = z.object({
  ...dataSchema.shape,
  schemaVersion: z.literal(1).default(1),
  settings: legacySettings.default(() => legacySettings.parse({})),
  tasks: z
    .array(
      taskSchema.extend({
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
  settings: v2Settings.default(() => v2Settings.parse({})),
});
const v3Data = v2Data.extend({
  schemaVersion: z.literal(3).default(3),
  settings: priorSettings.default(() => priorSettings.parse({})),
});

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
  if (fromVersion === 4) {
    const previous = z
      .object({ ...dataSchema.shape, schemaVersion: z.literal(4) })
      .parse(values);
    return dataSchema.parse({ ...previous, schemaVersion: 5 });
  }
  if (![1, 2, 3].includes(fromVersion))
    throw new Error("Unsupported Workboard storage version");
  const previous = v3Data.parse(
    fromVersion === 3 ? values : addInbox(values, fromVersion),
  );
  const { pinRunningWorkspaces, ...settings } = previous.settings;
  return dataSchema.parse({
    ...previous,
    schemaVersion: 5,
    settings: { ...settings, pinInProgressWorkspaces: pinRunningWorkspaces },
    autoPins: {},
  });
}
