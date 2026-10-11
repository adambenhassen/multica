import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@multica/ui/components/ui/chart";
import { useT } from "../../i18n";
import { successTone, type SuccessRatePoint } from "../utils";

const TONE_FILL = {
  success: "var(--success)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
} as const;

export function SuccessRateChart({ data }: { data: SuccessRatePoint[] }) {
  const { t } = useT("overview");
  const config = {
    rate: { label: t(($) => $.charts.success_rate) },
  } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="aspect-[3/1] w-full">
      <BarChart data={data} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 50, 100]}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(value: number) => `${value}%`}
          width="auto"
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              hideIndicator
              formatter={(value) => t(($) => $.charts.rate_tooltip, { rate: value })}
            />
          }
        />
        <Bar dataKey="rate" radius={[3, 3, 0, 0]}>
          {data.map((point) => (
            <Cell
              key={point.date}
              fill={point.rate === null ? "transparent" : TONE_FILL[successTone(point.rate)]}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
