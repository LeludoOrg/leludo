import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'happy-dom',
        include: ['src/test/**/*.test.js'],
        globals: false,
        coverage: {
            provider: 'v8',
            reportsDirectory: '.local/coverage',
            reporter: ['text', 'html'],
            include: ['src/scripts/**/*.js', 'src/components/**/*.js'],
            exclude: ['**/index.js'],
        },
    },
});
