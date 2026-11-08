package metrics

import "testing"

func TestRequestCostTicks(t *testing.T) {
	cases := []struct {
		name   string
		model  string
		tokens RequestTokens
		want   int64
	}{
		{
			// A captured Claude Code request; Claude Code reported $0.00292483.
			name:   "haiku 5.5 short prompt with 1h cache writes",
			model:  "claude-haiku-5-5",
			tokens: RequestTokens{Input: 2, Output: 4, CacheRead: 9403, CacheWrite1h: 14143},
			want:   29_248_300,
		},
		{
			name:   "haiku 5.5 prompt of exactly 100K stays on the base tier",
			model:  "claude-haiku-5-5",
			tokens: RequestTokens{CacheRead: 100_000, Output: 1000},
			want:   15_000_000,
		},
		{
			name:   "haiku 5.5 prompt over 100K bills every token at 5x",
			model:  "claude-haiku-5-5-20261001",
			tokens: RequestTokens{Input: 1, CacheRead: 100_000, Output: 1000},
			want:   75_005_000,
		},
		{
			name:   "opus 5.5 prices 5m and 1h cache writes separately",
			model:  "claude-opus-5-5[1m]",
			tokens: RequestTokens{Input: 10, CacheWrite: 1000, CacheWrite1h: 2000, CacheRead: 50_000, Output: 500},
			want:   410_400_000,
		},
		{
			name:   "opus 5.5 has no long-prompt tier",
			model:  "claude-opus-5-5",
			tokens: RequestTokens{CacheRead: 300_000},
			want:   600_000_000,
		},
		{
			name:   "gpt-6.1-sol prompt of exactly 272K stays on the short tier",
			model:  "gpt-6.1-sol",
			tokens: RequestTokens{CacheRead: 272_000, Output: 2000},
			want:   472_000_000,
		},
		{
			name:   "gpt-6.1-sol prompt over 272K bills input 2x and output 1.5x",
			model:  "gpt-6.1-sol",
			tokens: RequestTokens{Input: 1000, CacheRead: 300_000, Output: 2000},
			want:   940_000_000,
		},
		{
			name:   "gpt-6-luna long prompt includes cache writes in the prompt size",
			model:  "gpt-6-luna",
			tokens: RequestTokens{Input: 72_001, CacheWrite: 200_000, Output: 100},
			want:   644_752_000,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := RequestCostTicks(tc.model, tc.tokens)
			if !ok {
				t.Fatalf("RequestCostTicks(%q) not priced", tc.model)
			}
			if got != tc.want {
				t.Fatalf("RequestCostTicks(%q, %+v) = %d, want %d", tc.model, tc.tokens, got, tc.want)
			}
		})
	}
}

func TestRequestCostTicksUnpriced(t *testing.T) {
	cases := []struct {
		name   string
		model  string
		tokens RequestTokens
	}{
		{name: "unknown model", model: "claude-haiku-9-9", tokens: RequestTokens{Input: 10}},
		// The 1h write rate (2x input) is Anthropic's rule; no other provider
		// reports such writes, so they must not be priced by guesswork.
		{name: "1h writes on a non-Anthropic model", model: "gpt-6-sol", tokens: RequestTokens{CacheWrite1h: 10}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, ok := RequestCostTicks(tc.model, tc.tokens); ok {
				t.Fatalf("RequestCostTicks(%q) = %d, want unpriced", tc.model, got)
			}
		})
	}
}

func TestUsageCostTicksUsesBaseRates(t *testing.T) {
	// Aggregated usage carries no prompt sizes or cache lifetimes, so it is
	// priced at the base tier with every write at the default (5m) rate.
	got, ok := UsageCostTicks("claude-haiku-5-5", 2, 4, 9403, 14143)
	if !ok {
		t.Fatal("UsageCostTicks not priced")
	}
	if want := int64(18_641_050); got != want {
		t.Fatalf("UsageCostTicks = %d, want %d", got, want)
	}
	if _, ok := UsageCostTicks("claude-haiku-9-9", 1, 1, 1, 1); ok {
		t.Fatal("UsageCostTicks priced an unknown model")
	}
}
