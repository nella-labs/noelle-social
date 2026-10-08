import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "input h-10 w-full min-w-0 px-3 py-2 text-sm max-[768px]:text-base disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "input min-h-24 w-full px-3 py-2 text-sm max-[768px]:text-base disabled:cursor-not-allowed disabled:opacity-50 resize-y",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
