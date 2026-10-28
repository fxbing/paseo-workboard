import { StyleSheet, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  ACTIVITY_FILTERS,
  DATE_RANGES,
  REQUEST_FILTERS,
  type BoardFilters,
} from "./filters";
import type { strings } from "./strings";
import { ToolbarSelect } from "./ToolbarSelect";
import { design } from "./design";

export function FilterPanel({
  filters,
  onChange,
  t,
  theme,
}: {
  filters: BoardFilters;
  onChange(patch: Partial<BoardFilters>): void;
  t: ReturnType<typeof strings>;
  theme: PluginTheme;
}) {
  return (
    <View style={styles.panel}>
      <ToolbarSelect
        id="workboard-filter-activity"
        title={t.agentFilter}
        label={`${t.agentFilter}: ${filters.activity === "all" ? t.allStates : t.activity[filters.activity]}`}
        value={filters.activity}
        options={ACTIVITY_FILTERS.map((value) => ({
          value,
          label: value === "all" ? t.allStates : t.activity[value],
        }))}
        onSelect={(activity) =>
          onChange({ activity: activity as BoardFilters["activity"] })
        }
        theme={theme}
      />
      <ToolbarSelect
        id="workboard-filter-request"
        title={t.requestFilter}
        label={`${t.requestFilter}: ${t.requestFilters[filters.changeRequest]}`}
        value={filters.changeRequest}
        options={REQUEST_FILTERS.map((value) => ({
          value,
          label: t.requestFilters[value],
        }))}
        onSelect={(changeRequest) =>
          onChange({
            changeRequest: changeRequest as BoardFilters["changeRequest"],
          })
        }
        theme={theme}
      />
      <ToolbarSelect
        id="workboard-filter-date"
        title={t.dateFilter}
        label={`${t.dateFilter}: ${t.dateRanges[filters.dateRange]}`}
        value={filters.dateRange}
        options={DATE_RANGES.map((value) => ({
          value,
          label: t.dateRanges[value],
        }))}
        onSelect={(dateRange) =>
          onChange({ dateRange: dateRange as BoardFilters["dateRange"] })
        }
        theme={theme}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  panel: {
    paddingHorizontal: design.space.md,
    paddingTop: design.space.xs,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: design.space.xs,
  },
});
