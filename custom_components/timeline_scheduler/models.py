"""Data models for Timeline Scheduler."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


@dataclass
class When:
    type: str  # "time" | "anchor"
    at: str | None = None
    entity: str | None = None
    offset: str | None = None

    @classmethod
    def from_dict(cls, d: dict) -> "When":
        return cls(type=d["type"], at=d.get("at"),
                   entity=d.get("entity"), offset=d.get("offset"))

    def to_dict(self) -> dict:
        if self.type == "time":
            return {"type": "time", "at": self.at}
        if self.type == "anchor":
            return {"type": "anchor", "entity": self.entity, "offset": self.offset}
        raise ValueError(f"Unknown When type: {self.type!r}")


@dataclass
class Transition:
    id: str
    when: When
    value: Any
    weekdays: list[str] = field(default_factory=lambda: list(WEEKDAYS))

    @classmethod
    def from_dict(cls, d: dict) -> "Transition":
        return cls(id=d["id"], when=When.from_dict(d["when"]),
                   value=d["value"], weekdays=d["weekdays"] if "weekdays" in d else list(WEEKDAYS))

    def to_dict(self) -> dict:
        d: dict = {"id": self.id, "when": self.when.to_dict(), "value": self.value}
        if self.weekdays != WEEKDAYS:
            d["weekdays"] = self.weekdays
        return d


@dataclass
class Schedule:
    id: str
    name: str
    target: dict
    apply: str
    transitions: list[Transition]
    enabled: bool = True
    default: dict | None = None
    # True when this schedule is owned by a config subentry (created from the
    # "Add Schedule" UI). Server-authoritative: clients (card WS save, the
    # upsert_schedule service) must not be able to clear it. See websocket_api
    # and services, which preserve an existing schedule's flag on write.
    managed: bool = False

    @classmethod
    def from_dict(cls, d: dict) -> "Schedule":
        return cls(
            id=d["id"], name=d.get("name", d["id"]), target=d["target"],
            apply=d["apply"], enabled=d.get("enabled", True),
            default=d.get("default"), managed=d.get("managed", False),
            transitions=[Transition.from_dict(t) for t in d.get("transitions", [])],
        )

    def to_dict(self) -> dict:
        d: dict = {"id": self.id, "name": self.name, "enabled": self.enabled,
                   "target": self.target, "apply": self.apply, "default": self.default,
                   "transitions": [t.to_dict() for t in self.transitions]}
        if self.managed:
            d["managed"] = True
        return d
