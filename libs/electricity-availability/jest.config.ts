/* eslint-disable */
export default {
    displayName: 'electricity-availability',
    // preset: '../../jest.preset.js', // Assuming root preset exists, but let's be safe
    globals: {
        'ts-jest': {
            tsconfig: '<rootDir>/tsconfig.spec.json',
        },
    },
    testEnvironment: 'node',
    transform: {
        '^.+\\.[tj]s$': 'ts-jest',
    },
    moduleFileExtensions: ['ts', 'js', 'html', 'json'],
    coverageDirectory: '../../coverage/libs/electricity-availability',
    moduleNameMapper: {
        '^@electrobot/bot$': '<rootDir>/../../libs/bot/src/index.ts',
        '^@electrobot/domain$': '<rootDir>/../../libs/domain/src/index.ts',
        '^@electrobot/electricity-availability$': '<rootDir>/../../libs/electricity-availability/src/index.ts',
        '^@electrobot/electricity-repo$': '<rootDir>/../../libs/electricity-repo/src/index.ts',
        '^@electrobot/place-repo$': '<rootDir>/../../libs/place-repo/src/index.ts',
        '^@electrobot/user-repo$': '<rootDir>/../../libs/user-repo/src/index.ts'
    }
};
