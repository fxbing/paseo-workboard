import { expect, it } from "vitest";
import { CLOCK_OFFSET_ENV, workboardClock } from "../server/test-clock";

const MARKER = "paseo-workboard-integration-v1\n";
const read = (content: string | null) => (file: string) => {
  expect(file).toBe("/tmp/fixture-home/.paseo-workboard-integration");
  if (content === null) throw new Error("ENOENT");
  return content;
};
const now = () => 1_000;
const temporary = () => true;
const env = (extra: Record<string, string>) => ({
  PASEO_HOME: "/tmp/fixture-home",
  ...extra,
});

it("shifts the clock only with both the offset variable and the integration marker", () => {
  const offset = { [CLOCK_OFFSET_ENV]: "5000" };
  expect(workboardClock(env(offset), read(MARKER), now, temporary).now()).toBe(
    6_000,
  );
});
it("keeps the real clock when only the offset variable is set", () => {
  const offset = { [CLOCK_OFFSET_ENV]: "5000" };
  expect(workboardClock(env(offset), read(null), now, temporary).now()).toBe(
    1_000,
  );
  expect(
    workboardClock(
      { [CLOCK_OFFSET_ENV]: "5000" },
      read(MARKER),
      now,
      temporary,
    ).now(),
  ).toBe(1_000);
});
it("keeps the real clock when only the marker exists", () => {
  expect(workboardClock(env({}), read(MARKER), now, temporary).now()).toBe(
    1_000,
  );
});
it("keeps the real clock when the marker content is wrong or the offset is invalid", () => {
  const offset = { [CLOCK_OFFSET_ENV]: "5000" };
  expect(
    workboardClock(env(offset), read("other\n"), now, temporary).now(),
  ).toBe(1_000);
  for (const bad of ["-5", "1e9", "abc", "", "1.5"])
    expect(
      workboardClock(
        env({ [CLOCK_OFFSET_ENV]: bad }),
        read(MARKER),
        now,
        temporary,
      ).now(),
    ).toBe(1_000);
  expect(
    workboardClock(
      { [CLOCK_OFFSET_ENV]: "5000", PASEO_HOME: "relative/home" },
      () => MARKER,
      now,
      temporary,
    ).now(),
  ).toBe(1_000);
});

it("reports the offset it applies, and zero otherwise", () => {
  const offset = { [CLOCK_OFFSET_ENV]: "5000" };
  expect(
    workboardClock(env(offset), read(MARKER), now, temporary).offsetMs,
  ).toBe(5_000);
  expect(workboardClock(env(offset), read(null), now, temporary).offsetMs).toBe(
    0,
  );
  expect(workboardClock(env({}), read(MARKER), now, temporary).offsetMs).toBe(
    0,
  );
});

it("keeps the real clock outside a temporary directory", () => {
  const offset = { [CLOCK_OFFSET_ENV]: "5000" };
  expect(
    workboardClock(env(offset), read(MARKER), now, () => false).now(),
  ).toBe(1_000);
  // The real check refuses a home outside the system temporary directory.
  expect(
    workboardClock(
      { ...offset, PASEO_HOME: "/usr/local" },
      () => MARKER,
      now,
    ).now(),
  ).toBe(1_000);
});
