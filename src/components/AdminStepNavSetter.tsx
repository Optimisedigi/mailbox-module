'use client'

import { SetStepNav, type StepNavItem } from '@payloadcms/ui'

export interface AdminStepNavSetterProps {
  items: StepNavItem[]
}

const AdminStepNavSetter = ({ items }: AdminStepNavSetterProps) => {
  return <SetStepNav nav={items} />
}

export default AdminStepNavSetter
