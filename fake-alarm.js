/**
 * Alarm testowy — tylko gdy ALLOW_FAKE_ALARM=1 (żeby nie odpalać przypadkiem na produkcji).
 */

import { normalizeEremizaDateField } from "./eremiza-date.js";

export function isFakeAlarmEnabled() {
  const v = process.env.ALLOW_FAKE_ALARM?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Obiekt w kształcie zbliżonym do tego z e-Remiza (index: type, address, description, coords).
 * `coords` = miejsce zdarzenia (dla mapy trasy OSP→zdarzenie). NIE używaj tu FIRE_BRIGADE /
 * bazy OSP — wtedy oba punkty trasy są w tym samym miejscu.
 */
export function buildFakeAlert() {
  const coords =
    process.env.FAKE_INCIDENT_COORDS?.trim() ||
    "51.17965581326412,22.470462800907764";
  return {
    test: true,
    type: "TEST — fałszywy alarm (ćwiczenie)",
    address: "ul. Ćwiczebna 1, 00-001 Warszawa",
    description:
      "To nie jest prawdziwy alarm. Sprawdź reakcje pod opcjami i podgląd /board.",
    coords,
    date: normalizeEremizaDateField(new Date().toISOString()),
    incidentId: `test-${Date.now()}`,
  };
}
