'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getDatabaseClient, requireWebSession } from '../../../../server/runtime.js';
import {
  createSendingSettings,
  liveActivationStatusForError
} from './sending-settings.js';
const text=(formData:FormData,name:string)=>{const value=formData.get(name);if(typeof value!=='string'||value.trim()==='')throw new Error(`${name} is required`);return value;};
async function context(){const session=await requireWebSession(new Request('http://localhost/',{headers:await headers()}));return{session,settings:createSendingSettings({database:getDatabaseClient().db,clock:{now:()=>new Date()}})};}
export async function updateAllowlist(formData:FormData):Promise<void>{const{session,settings}=await context();await settings.updateAllowlist(session,{organisationId:text(formData,'organisationId'),recipients:text(formData,'recipients').split(/[\n,]/)});revalidatePath('/settings/sending');}
export async function activateLive(formData:FormData):Promise<void>{
  let failure: string | undefined;
  try {
    const{session,settings}=await context();
    await settings.activateLive(session,{organisationId:text(formData,'organisationId'),acknowledgement:text(formData,'acknowledgement')});
  } catch (error) {
    failure = liveActivationStatusForError(error);
  }
  if (failure !== undefined) {
    redirect(`/settings/sending?activation=${encodeURIComponent(failure)}`);
  }
  revalidatePath('/settings/sending');
  redirect('/settings/sending?activation=enabled');
}
export async function disableLive(formData:FormData):Promise<void>{const{session,settings}=await context();await settings.disableLive(session,{organisationId:text(formData,'organisationId'),reason:text(formData,'reason')});revalidatePath('/settings/sending');}
