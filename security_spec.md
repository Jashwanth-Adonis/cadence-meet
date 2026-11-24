# Security Specification & Red-Team Payloads

## 1. Data Invariants
1. Every document under `/users/{userId}` and its subcollections (`folders`, `meetings`, `tasks`) belongs strictly to `userId == request.auth.uid`.
2. Unauthenticated or unverified-email requests (`request.auth.token.email_verified != true`) are rejected for all mutations.
3. No user can list `/users` across accounts; `list` on subcollections explicitly requires `resource.data.ownerId == request.auth.uid`.
4. `ownerId` and `createdAt` are immutable once created; `createdAt` and `updatedAt` must equal `request.time`.
5. All string fields enforce explicit `.size()` bounds; `tags` list is bounded to `<= 10` items; document IDs match `^[a-zA-Z0-9_\-]+$`.
6. Subcollection writes (`folders`, `meetings`, `tasks`) verify the parent `/users/{userId}` document exists via `exists()`.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Cross-user impersonation**: Create `/users/victimUid/meetings/m1` with `ownerId: "victimUid"` while signed in as `attackerUid`.
2. **Owner field hijacking on create**: Create `/users/attackerUid/meetings/m1` with `ownerId: "victimUid"`.
3. **Unverified email spoofing**: Write to `/users/u1/tasks/t1` with `email_verified: false`.
4. **Shadow field injection**: Create a meeting doc with an extra undeclared field `isAdmin: true`.
5. **Oversized ID poisoning**: Create `/users/u1/meetings/<200-char-invalid-id!>` with non-alphanumeric chars.
6. **Payload bloat / Denial of Wallet**: Create a meeting doc with `encryptedPayload` exceeding 600,000 characters.
7. **Unbounded array injection**: Create a meeting doc with 25 tags (`tags.size() > 10`).
8. **Immutable field tampering**: Update a task's `ownerId` or `createdAt` after creation.
9. **Client timestamp forgery**: Create or update a folder with a backdated `createdAt` or `updatedAt` != `request.time`.
10. **Invalid status enum**: Update a task `status` to `"deleted_bypass"`.
11. **Orphaned subcollection write**: Create a task under `/users/u1/tasks/t1` when `/users/u1` profile does not exist.
12. **Blanket user directory enumeration**: Execute `list` query against `/users`.
