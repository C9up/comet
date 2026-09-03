import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			// Set just under what the suite actually reaches, so the gate can
			// only be crossed downwards on purpose. It sat well below the real
			// figures and was never run by CI, which is the same as absent.
			thresholds: {
				lines: 97,
				statements: 96,
				branches: 92,
				functions: 95,
			},
		},
	},
});
