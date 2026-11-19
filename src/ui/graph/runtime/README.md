# Runtime

This layer is not built.

It is the source that knows what really runs: the exact target of each call,
from the types of a build (compile commands) or from a run. It is the only
layer that can give the full flow graph.

When it is built, it gives arrows and cards to `basic/build.ts`, as a repo
does through `GraphRepo.connect`, and it replaces the arrows of the Repo
layer that come from a style.
