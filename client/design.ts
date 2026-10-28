import { StyleSheet } from "react-native";

// Host theme colors own surfaces, text, borders and interaction feedback.
// Group and priority colors identify metadata; they never replace text labels.
export const design = {
  space: { xs: 4, sm: 8, md: 12, lg: 16 },
  radius: { control: 6, card: 8, panel: 10 },
  control: { minHeight: 36, minWidth: 36 },
  disabledOpacity: 0.5,
  borderWidth: 1,
} as const;

// Inherit Paseo's font family, including the controls and secondary metadata.
export const typography = StyleSheet.create({
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "600" },
  title: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  body: { fontSize: 14, lineHeight: 20 },
  meta: { fontSize: 13, lineHeight: 18 },
});
