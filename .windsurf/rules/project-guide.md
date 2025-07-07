---
trigger: manual
---

---
trigger: always_on
---

# Windsurf Rules


### File Naming Conventions

- Use kebab-case for file names: `add-item-form.tsx`
- Schema files: `*-schema.ts` (e.g., `add-item-schema.ts`)
- Action files: `*.ts` in `/actions` folder
- Data fetching: `get-*.ts` in `/data` folder
- DTOs: `*-dto.ts` in `/types/dtos`


## UI Component Rules

### Component Organization
- Use proper TypeScript interfaces for props
- Follow Shadcn UI patterns and conventions

### Styling Rules
- Use Tailwind CSS for styling
- Prefer utility classes over custom CSS
- Use `cn()` utility for conditional classes
- Follow responsive design patterns

## Import Rules

### Import Order

1. React imports
2. Third-party libraries
3. Workspace packages (`@workspace/*`)
4. Relative imports (`~/`)

## Code Quality Rules

### TypeScript

- Use strict TypeScript configuration
- Define proper interfaces and types
- Avoid `any` type usage
- Use type guards when necessary

### Code Organization

- Keep functions small and focused
- Use descriptive names for variables and functions
- Implement proper separation of concerns
- Follow single responsibility principle

```
