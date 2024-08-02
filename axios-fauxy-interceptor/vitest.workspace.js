import { defineWorkspace } from "vitest/config";
export default defineWorkspace([
    {
        test: {
            include: ["src/**/*.unit.ts"],
            name: "unit",
        },
    },
    {
        test: {
            include: ["src/**/*.integrated.ts"],
            name: "integrated",
        },
    },
]);
