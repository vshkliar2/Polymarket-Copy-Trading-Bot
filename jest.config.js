module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/src/test/'],
    transform: {
        '^.+\\.ts$': 'ts-jest',
    },
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/test/**', '!src/scripts/**'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    verbose: true,
};
