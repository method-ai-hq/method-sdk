"""Python API for Method. Requires Node.js 22 and @withmethod/sdk."""
from .client import WorkflowError, load_workflow, render_prompt, run_workflow, run_method

__version__ = "0.4.1"
MethodError = WorkflowError
load_method = load_workflow
__all__ = ["MethodError", "load_method", "run_method", "render_prompt", "WorkflowError", "load_workflow", "run_workflow"]
