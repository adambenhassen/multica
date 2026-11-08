package metrics

import "math"

// RequestTokens is one model API request's usage. The counts are mutually
// exclusive: Input excludes cache reads and writes. CacheWrite is the
// provider's default write (Anthropic's 5-minute lifetime); CacheWrite1h is
// Anthropic's 1-hour write.
type RequestTokens struct {
	Input        int64
	Output       int64
	CacheRead    int64
	CacheWrite   int64
	CacheWrite1h int64
}

// longPromptTier bills a whole request at higher rates once its prompt (every
// input token, cache reads and writes included) exceeds threshold tokens. The
// input multiplier applies to input, cache reads and cache writes.
type longPromptTier struct {
	threshold        int64
	inputMultiplier  float64
	outputMultiplier float64
}

// Keyed by price row (Provider:Model). Sources: platform.claude.com pricing
// ("Long context pricing") and developers.openai.com/api/docs/pricing
// ("Long context: >272K input tokens"), 2026-11-08.
var longPromptTiers = map[string]longPromptTier{
	"anthropic:claude-haiku-5-5": {threshold: 100_000, inputMultiplier: 5, outputMultiplier: 5},
	"openai:gpt-6-astra":         {threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5},
	"openai:gpt-6-sol":           {threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5},
	"openai:gpt-6-luna":          {threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5},
	"openai:gpt-6.1-sol":         {threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5},
	"openai:gpt-6.1-terra":       {threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5},
}

// anthropic1hWriteMultiplier is Anthropic's 1-hour cache write price as a
// multiple of base input, for every model.
const anthropic1hWriteMultiplier = 2

// RequestCostTicks prices one API request at list price, in 1e-10 USD. Unlike
// aggregated usage, a single request knows its prompt size and cache-write
// lifetimes, so long-prompt tiers and 1-hour writes are applied. ok is false
// when the model has no price row.
func RequestCostTicks(model string, t RequestTokens) (int64, bool) {
	price, ok := PriceForModelAlias(model)
	if !ok {
		return 0, false
	}
	if t.CacheWrite1h > 0 && price.Provider != "anthropic" {
		return 0, false
	}
	in, out := 1.0, 1.0
	if tier, ok := longPromptTiers[price.Provider+":"+price.Model]; ok &&
		t.Input+t.CacheRead+t.CacheWrite+t.CacheWrite1h > tier.threshold {
		in, out = tier.inputMultiplier, tier.outputMultiplier
	}
	usd := tokenCostUSD(t.Input, price.InputPerM*in) +
		tokenCostUSD(t.CacheRead, price.CacheReadPerM*in) +
		tokenCostUSD(t.CacheWrite, price.CacheWritePerM*in) +
		tokenCostUSD(t.CacheWrite1h, price.InputPerM*anthropic1hWriteMultiplier*in) +
		tokenCostUSD(t.Output, price.OutputPerM*out)
	return usdToTicks(usd), true
}

// UsageCostTicks estimates aggregated usage at the base rates, in 1e-10 USD.
// Aggregates carry neither prompt sizes nor cache lifetimes, so this is the
// same estimate the dashboard computes from its own rate table.
func UsageCostTicks(model string, input, output, cacheRead, cacheWrite int64) (int64, bool) {
	price, ok := PriceForModelAlias(model)
	if !ok {
		return 0, false
	}
	usd := tokenCostUSD(input, price.InputPerM) +
		tokenCostUSD(output, price.OutputPerM) +
		tokenCostUSD(cacheRead, price.CacheReadPerM) +
		tokenCostUSD(cacheWrite, price.CacheWritePerM)
	return usdToTicks(usd), true
}

func usdToTicks(usd float64) int64 {
	return int64(math.Round(usd * CostUSDTicksPerUSD))
}
