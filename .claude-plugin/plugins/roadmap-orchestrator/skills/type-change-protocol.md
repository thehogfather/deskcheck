---
name: type-change-protocol
description: |
  Protocol for updating test fixtures when type definitions change. Use this skill when modifying types in src/types/ or any shared type definitions. Ensures test fixtures remain in sync with type changes.
---

# Type Change Protocol

When you modify type definitions, you **must** also update any test fixtures that use those types.

## When This Applies

- Modifying `src/types/index.ts` or similar type definition files
- Adding new required properties to existing types
- Renaming properties on types
- Changing property types
- Removing properties from types

## Required Steps

### 1. Identify Affected Test Files

After modifying types, search for test files that use those types:

```bash
# Find test files that import the modified types
grep -r "from.*types" --include="*.test.ts" --include="*.test.tsx" src/
```

### 2. Update Test Fixtures

Test files often have `createMock*` or fixture functions like:

```typescript
const createMockThread = (id: string) => ({
  id,
  title: `Thread ${id}`,
  // ... other properties
});
```

These must be updated to include all required properties from the new type definition.

### 3. Update Test Assertions

If property names changed, update assertions:

```typescript
// Before: expect(result.oldPropertyName).toBe(...)
// After:  expect(result.newPropertyName).toBe(...)
```

### 4. Handle Serialization Tests

Serialization tests need special attention:
- Test fixtures for serialized data should have dates as **strings**, not Date objects
- Don't spread from mock creators into serialized fixtures (keeps Date types)
- Create separate serialized fixture creators if needed

### 5. Verify Changes

After updating:

```bash
npx tsc --noEmit  # Should pass with no errors
npm run test:run  # All tests should pass
```

## Common Type Change Patterns

| Change Type | Fixture Update Required |
|-------------|------------------------|
| Add required property | Add to all fixtures |
| Add optional property | No fixture change needed |
| Rename property | Update fixtures + assertions |
| Remove property | Remove from fixtures |
| Change property type | Update fixture values |

## Example

If you change:
```typescript
// Before
type Exchange = {
  ai: { content: string };
};

// After
type Exchange = {
  assistant: { content: string };
};
```

Update fixtures:
```typescript
// Before
const createMockExchange = () => ({
  ai: { content: 'Response' },
});

// After
const createMockExchange = () => ({
  assistant: { content: 'Response' },
});
```

And assertions:
```typescript
// Before
expect(exchange.ai.content).toBe('Response');

// After
expect(exchange.assistant.content).toBe('Response');
```
