# 通用类型系统 (Type System) 使用文档

为了提升 `qq-music-api` 项目的类型安全性、可读性以及代码的可维护性，我们在 `src/types/core/base.ts` 中实现了一个通用的类型定义抽象层。该类型系统遵循 SOLID 原则，具备良好的可扩展性和严格的类型检查能力。

## 目录

1. [基础泛型接口](#基础泛型接口)
2. [类型组合与派生](#类型组合与派生)
3. [类型约束与条件类型](#类型约束与条件类型)
4. [最佳实践与设计原则](#最佳实践与设计原则)

---

## 基础泛型接口

### `Dictionary<T>`
用于定义任意键值对的映射（Map），键固定为字符串，值由泛型 `T` 决定。
```typescript
import { Dictionary } from '@/types/core/base';

const userMap: Dictionary<string> = {
  "id1": "Alice",
  "id2": "Bob"
};
```

### `ApiResponse<T>`
用于统一规范后端接口的响应数据结构。
```typescript
import { ApiResponse } from '@/types/core/base';

interface User { id: number; name: string; }

const res: ApiResponse<User> = {
  code: 0,
  message: "Success",
  data: { id: 1, name: "Alice" }
};
```

### `PaginatedResponse<T>`
分页数据响应结构。
```typescript
import { PaginatedResponse } from '@/types/core/base';

const list: PaginatedResponse<User> = {
  list: [{ id: 1, name: "Alice" }],
  total: 100,
  page: 1,
  size: 10
};
```

### `Result<T, E>`
借鉴 Rust 的错误处理模式，通过显式的可辨识联合类型来替代 `try-catch`。它包含 `Ok<T>` 和 `Err<E>`。
```typescript
import { Result } from '@/types/core/base';

function divide(a: number, b: number): Result<number, string> {
  if (b === 0) {
    return { ok: false, error: "Division by zero" };
  }
  return { ok: true, value: a / b };
}

const result = divide(10, 2);
if (result.ok === true) {
  console.log(result.value); // TS 自动推断为 number
} else {
  console.error(result.error); // TS 自动推断为 string
}
```

---

## 类型组合与派生

### `Nullable<T>`
表示某个类型的值可以是其本身，也可以是 `null` 或 `undefined`。
```typescript
let name: Nullable<string> = null;
```

### `DeepPartial<T>`
递归地将对象及其所有嵌套属性变为可选。
```typescript
interface AppConfig {
  db: { host: string; port: number };
  cache: string[];
}

type PartialConfig = DeepPartial<AppConfig>;
// 等价于: { db?: { host?: string; port?: number }; cache?: string[] }
```

### `DeepReadonly<T>`
递归地将对象及其所有嵌套属性变为只读，防止意外修改。
```typescript
const state: DeepReadonly<{ user: { name: string } }> = { user: { name: "Bob" } };
// state.user.name = "Alice"; // TS 编译报错: Cannot assign to 'name' because it is a read-only property.
```

### `Mutable<T>`
将只读类型转换为可写类型。
```typescript
interface ReadonlyUser { readonly id: number; }
type WritableUser = Mutable<ReadonlyUser>; // { id: number; }
```

---

## 类型约束与条件类型

### `PromiseType<T>`
提取 Promise 内部解析的值类型。
```typescript
type AsyncResult = Promise<string>;
type T0 = PromiseType<AsyncResult>; // string
```

### `RequireAtLeastOne<T, Keys>`
约束一个对象至少需要包含指定的属性之一。
```typescript
interface Contact { email: string; phone: string; address: string; }

// 必须包含 email 或 phone 其中至少一个
type AtLeastOneContact = RequireAtLeastOne<Contact, 'email' | 'phone'>;

const c1: AtLeastOneContact = { email: "a@b.com", address: "Home" }; // 正确
const c2: AtLeastOneContact = { address: "Home" }; // 报错，缺少 email 或 phone
```

### `RequireExactlyOne<T, Keys>`
约束一个对象在指定的属性中只能包含恰好一个，不能同时包含多个。
```typescript
interface Identity { idCard: string; passport: string; name: string; }

// 只能有 idCard 或 passport 其中之一
type OneIdentity = RequireExactlyOne<Identity, 'idCard' | 'passport'>;

const i1: OneIdentity = { idCard: "111", name: "Alice" }; // 正确
const i2: OneIdentity = { idCard: "111", passport: "222", name: "Bob" }; // 报错
```

### `If<Condition, TrueType, FalseType>`
基于布尔条件的类型分支。
```typescript
type IsString<T> = If<T extends string ? true : false, "Yes", "No">;
type Result1 = IsString<string>; // "Yes"
```

### `IsEqual<X, Y>`
严格检查两个类型是否完全相等。通常用于测试环境下的类型断言。
```typescript
type Test1 = IsEqual<string, string>; // true
type Test2 = IsEqual<string, number>; // false
```

---

## 最佳实践与设计原则

1. **接口隔离 (ISP)**：通过 `RequireAtLeastOne` 和 `RequireExactlyOne` 等约束类型，精确限制对象所需具备的属性，防止业务层传递不必要的“大而全”的接口。
2. **错误处理替代方案**：推荐业务逻辑和外部调用使用 `Result<T, E>` 进行返回值包装，提升代码在异常分支的类型安全性，避免运行时意外抛错导致的进程崩溃。
3. **不可变数据 (Immutability)**：在 Redux 类似的状态管理或传递上下文选项时，推荐使用 `DeepReadonly` 包装以避免数据被意外篡改。
