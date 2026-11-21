import * as React from 'react';
import { Command as Cmdk } from 'cmdk';
import { Search } from 'lucide-react';

import { cn } from '@/lib/utils';

// Each wrapper takes exactly the cmdk primitive's props (minus ref) and
// forwards its ref to the primitive's element, adding only the look.
type PropsOf<T extends React.ElementType> = React.ComponentPropsWithoutRef<T>;
type RefOf<T extends React.ElementType> = React.ComponentRef<T>;

export const Command = React.forwardRef<RefOf<typeof Cmdk>, PropsOf<typeof Cmdk>>(
  function Command({ className, ...rest }, ref) {
    return <Cmdk ref={ref} className={cn('flex flex-col', className)} {...rest} />;
  },
);
Command.displayName = Cmdk.displayName;

export const CommandInput = React.forwardRef<RefOf<typeof Cmdk.Input>, PropsOf<typeof Cmdk.Input>>(
  function CommandInput({ className, ...rest }, ref) {
    return (
      <div className="flex items-center border-b border-border px-3">
        <Search aria-hidden className="mr-2 size-3.5 shrink-0 text-muted-foreground" />
        <Cmdk.Input
          ref={ref}
          className={cn(
            'flex h-(--target-touch) w-full bg-transparent text-body outline-none',
            'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60',
            className,
          )}
          {...rest}
        />
      </div>
    );
  },
);
CommandInput.displayName = Cmdk.Input.displayName;

export const CommandList = React.forwardRef<RefOf<typeof Cmdk.List>, PropsOf<typeof Cmdk.List>>(
  function CommandList({ className, ...rest }, ref) {
    return (
      <Cmdk.List
        ref={ref}
        className={cn('max-h-(--size-command-list) overflow-x-hidden overflow-y-auto p-1.5', className)}
        {...rest}
      />
    );
  },
);
CommandList.displayName = Cmdk.List.displayName;

export const CommandEmpty = React.forwardRef<RefOf<typeof Cmdk.Empty>, PropsOf<typeof Cmdk.Empty>>(
  function CommandEmpty(props, ref) {
    return <Cmdk.Empty ref={ref} className="py-6 text-center text-body text-muted-foreground" {...props} />;
  },
);
CommandEmpty.displayName = Cmdk.Empty.displayName;

// The group heading reads like LABEL; Tailwind needs the classes written out to generate them.
const GROUP_HEADING =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 ' +
  '[&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase ' +
  '[&_[cmdk-group-heading]]:tracking-label [&_[cmdk-group-heading]]:text-muted-foreground';

export const CommandGroup = React.forwardRef<RefOf<typeof Cmdk.Group>, PropsOf<typeof Cmdk.Group>>(
  function CommandGroup({ className, ...rest }, ref) {
    return (
      <Cmdk.Group ref={ref} className={cn('overflow-hidden text-foreground', GROUP_HEADING, className)} {...rest} />
    );
  },
);
CommandGroup.displayName = Cmdk.Group.displayName;

export const CommandItem = React.forwardRef<RefOf<typeof Cmdk.Item>, PropsOf<typeof Cmdk.Item>>(
  function CommandItem({ className, ...rest }, ref) {
    return (
      <Cmdk.Item
        ref={ref}
        className={cn(
          'relative flex min-h-(--target-comfortable) cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 text-body outline-none select-none',
          'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
          'data-[disabled=true]:pointer-events-none data-[disabled=true]:text-muted-foreground',
          className,
        )}
        {...rest}
      />
    );
  },
);
CommandItem.displayName = Cmdk.Item.displayName;

export const CommandSeparator = React.forwardRef<RefOf<typeof Cmdk.Separator>, PropsOf<typeof Cmdk.Separator>>(
  function CommandSeparator({ className, ...rest }, ref) {
    return <Cmdk.Separator ref={ref} className={cn('-mx-1.5 h-px bg-border', className)} {...rest} />;
  },
);
CommandSeparator.displayName = Cmdk.Separator.displayName;
