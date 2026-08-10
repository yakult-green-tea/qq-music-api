module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.ts'],
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/.worktrees/', '<rootDir>/dist/'],
  modulePathIgnorePatterns: ['<rootDir>/.worktrees/', '<rootDir>/dist/'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/controllers/**/*.ts',
    'src/services/**/*.ts',
    'src/util/lyricParse.ts',
    '!src/**/*.d.ts',
    '!src/app.ts',
    '!src/routes/**'
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 75,
      statements: 75,
    },
  },
};
