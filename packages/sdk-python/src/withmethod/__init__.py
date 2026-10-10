"""Python API for Method. Requires Node.js 22 and @withmethod/sdk."""
from .client import WorkflowError, load_workflow, render_prompt, run_method
from .production import Method, MethodApiError, Question, Worker, verify_webhook

__version__ = "0.5.0"
MethodError = WorkflowError
load_method = load_workflow
__all__ = ["Method", "MethodApiError", "Question", "Worker", "verify_webhook", "MethodError", "load_method", "run_method", "render_prompt", "WorkflowError", "load_workflow"]
