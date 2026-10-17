package main

import (
	"slices"
	"testing"
)

func TestParseAgentTimerAgentIDs(t *testing.T) {
	const a, b = "01900000-0000-7000-8000-0000000000a1", "01900000-0000-7000-8000-0000000000b2"
	for _, tc := range []struct {
		name string
		in   string
		want []string
	}{
		{"unset", "", nil},
		{"whitespace and empty entries", " " + a + " ,, " + b + "\t", []string{a, b}},
		{"canonical form", "01900000-0000-7000-8000-0000000000A1,019000000000700080000000000000b2", []string{a, b}},
		{"invalid entries dropped", a + ",not-a-uuid, 123", []string{a}},
		{"all invalid", "nope", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseAgentTimerAgentIDs(tc.in); !slices.Equal(got, tc.want) {
				t.Fatalf("parseAgentTimerAgentIDs(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
