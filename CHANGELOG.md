# Changelog

中文：[中文](CHANGELOG.zh-CN.md)

All notable changes are documented here.

## Unreleased

- Save general setting switches immediately so their values survive leaving and reopening Settings, while confirming automatic archive when workspaces are already due.
- Accept Paseo `>=0.9.1` and validate the internal host bridge on 0.10.0-beta.1.
- Align the development SDK and isolated integration suite with Paseo 0.10.0-beta.1.

## 0.1.0 — 2026-09-24

- Follow Paseo's desktop language for Chinese/English UI and dates; migrate away from the separate plugin language preference.
- Add a Paseo 0.9.1 Workboard plugin for workspace-backed tasks and unbound
  draft todos.
- Add configurable groups, native workspace-label synchronization, group
  colors, saved desktop layout preferences, and combined board filters.
- Add task activity, MR/PR metadata, attention reasons, accessible compact
  controls, keyboard navigation, and contextual hints.
- Confirm group deletion and draft archiving, and report task saves hidden by active filters.
- Preserve desktop collapse preferences during compact navigation and start each compact group at the top.
- Add optional in-progress sidebar pinning that preserves manually managed
  pins, plus guarded automatic archive handling for eligible terminal tasks.
- Add deterministic unit coverage and an isolated, marked Paseo integration
  suite with a fixture provider that does not request a real model.
